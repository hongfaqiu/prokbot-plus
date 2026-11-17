//go:build windows

// Per-user installer for the patched Windows client. The patcher appends a zip of the
// application directory and a footer to this stub; the same executable, without the
// payload, is installed as the uninstaller. Only the Go standard library is used.
package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	appName      = "Grok Bot Local"
	exeName      = "Grok Bot.exe"
	uninstaller  = "Uninstall Grok Bot Local.exe"
	registryKey  = `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokBotLocal`
	footerMagic  = "GROKBOT-SETUP-V1"
	footerLength = 8 + 8 + 16
)

var (
	errInUse         = errors.New("Grok Bot Local is running. Quit it first.")
	user32           = syscall.NewLazyDLL("user32.dll")
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	messageBox       = user32.NewProc("MessageBoxW")
	createWindow     = user32.NewProc("CreateWindowExW")
	destroyWindow    = user32.NewProc("DestroyWindow")
	translateMessage = user32.NewProc("TranslateMessage")
	dispatchMessageW = user32.NewProc("DispatchMessageW")
	setWindowText    = user32.NewProc("SetWindowTextW")
	systemMetrics    = user32.NewProc("GetSystemMetrics")
	uiLanguage       = kernel32.NewProc("GetUserDefaultUILanguage")
	regGetValue      = syscall.NewLazyDLL("advapi32.dll").NewProc("RegGetValueW")
	silent           bool
	chinese          bool
)

func text(zh, en string) string {
	if chinese {
		return zh
	}
	return en
}

const (
	mbOK          = 0x0
	mbYesNo       = 0x4
	mbIconInfo    = 0x40
	mbIconWarning = 0x30
	mbIconError   = 0x10
	mbDefButton2  = 0x100
	idYes         = 6
)

func ask(message string, flags uintptr) bool {
	if silent {
		return flags&mbDefButton2 == 0
	}
	title, _ := syscall.UTF16PtrFromString(appName)
	body, _ := syscall.UTF16PtrFromString(message)
	result, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), flags|mbYesNo)
	return result == idYes
}

func tell(message string, flags uintptr) {
	if silent {
		fmt.Fprintln(os.Stderr, message)
		return
	}
	title, _ := syscall.UTF16PtrFromString(appName)
	body, _ := syscall.UTF16PtrFromString(message)
	messageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), flags)
}

// showProgress keeps a responsive status window on a dedicated UI thread while files are written.
func showProgress(message string) *asyncProgress {
	return showAsyncProgress(message)
}

type payload struct {
	file   *os.File
	offset int64
	size   int64
}

func readPayload(path string) (*payload, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || info.Size() < footerLength {
		file.Close()
		return nil, errors.New("installer payload missing")
	}
	footer := make([]byte, footerLength)
	if _, err := file.ReadAt(footer, info.Size()-footerLength); err != nil || string(footer[16:]) != footerMagic {
		file.Close()
		return nil, errors.New("installer payload missing")
	}
	offset, size := int64(binary.LittleEndian.Uint64(footer)), int64(binary.LittleEndian.Uint64(footer[8:]))
	if offset <= 0 || size <= 0 || offset != info.Size()-footerLength-size {
		file.Close()
		return nil, errors.New("installer payload is damaged")
	}
	return &payload{file: file, offset: offset, size: size}, nil
}

func defaultDirectory() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", appName)
}

func startMenuShortcut() string {
	return filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`, appName+".lnk")
}

// Check delete access without ever renaming a user's directory as a probe.
func inUse(directory string) bool {
	for _, name := range []string{exeName, uninstaller} {
		h, err := syscall.CreateFile(winPath(filepath.Join(directory, name)), deleteAccess,
			syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil,
			syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err == nil {
			syscall.CloseHandle(h)
		} else if !errors.Is(err, os.ErrNotExist) {
			return true
		}
	}
	return false
}

// closeRunningProcesses terminates Grok Bot executables inside directory so upgrades can overwrite files cleanly.
func closeRunningProcesses(directory string) {
	dir := strings.TrimRight(filepath.Clean(directory), `\`) + `\`
	script := `$ErrorActionPreference = 'SilentlyContinue'
$dir = $env:GB_INSTALL_DIR
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	command.Env = append(os.Environ(), "GB_INSTALL_DIR="+dir)
	_ = command.Run()
}

// waitUntilClosed automatically stops a running client in directory, falling back to a prompt if locked.
func waitUntilClosed(directory string) (bool, error) {
	// A relaunched uninstaller or in-app updater may still be exiting from the same folder.
	for attempt := 0; attempt < 4 && inUse(directory); attempt++ {
		time.Sleep(350 * time.Millisecond)
	}
	if inUse(directory) {
		closeRunningProcesses(directory)
		for attempt := 0; attempt < 24 && inUse(directory); attempt++ {
			time.Sleep(250 * time.Millisecond)
		}
	}
	for inUse(directory) {
		closeRunningProcesses(directory)
		for attempt := 0; attempt < 8 && inUse(directory); attempt++ {
			time.Sleep(250 * time.Millisecond)
		}
		if !inUse(directory) {
			break
		}
		if silent {
			return false, errInUse
		}
		if !ask(text("无法自动关闭运行中的 Grok Bot Local。请在通知区域图标菜单中选择“退出”，然后点“是”继续。",
			"Could not automatically close the running Grok Bot Local. Choose Quit from its notification-area icon, then select Yes to continue."), mbIconWarning) {
			return false, nil
		}
	}
	return true, nil
}

func extract(data *payload, target string, report func(done, total int)) (uint64, error) {
	reader, err := zip.NewReader(io.NewSectionReader(data.file, data.offset, data.size), data.size)
	if err != nil {
		return 0, err
	}
	var written uint64
	// The payload is also the portable archive: everything sits under one top folder.
	prefix := appName + "/"
	for index, entry := range reader.File {
		if !strings.HasPrefix(entry.Name, prefix) {
			return 0, fmt.Errorf("unexpected payload path %q", entry.Name)
		}
		rel := strings.TrimPrefix(entry.Name, prefix)
		if rel == "" {
			continue
		}
		name := strings.TrimSuffix(rel, "/")
		if !localName(name) || strings.EqualFold(name, receiptName) || strings.EqualFold(name, uninstaller) ||
			(!entry.Mode().IsRegular() && !entry.Mode().IsDir()) {
			return 0, fmt.Errorf("unsafe payload path %q", entry.Name)
		}
		destination := filepath.Join(target, filepath.FromSlash(name))
		if strings.HasSuffix(entry.Name, "/") {
			if err := os.MkdirAll(destination, 0o755); err != nil {
				return 0, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return 0, err
		}
		source, err := entry.Open()
		if err != nil {
			return 0, err
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			source.Close()
			return 0, err
		}
		count, copyErr := io.Copy(output, source)
		copyErr = errors.Join(copyErr, source.Close(), output.Close())
		if copyErr != nil {
			return 0, copyErr
		}
		written += uint64(count)
		report(index+1, len(reader.File))
	}
	return written, nil
}

func run(name string, args ...string) error {
	command := exec.Command(name, args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", name, err, bytes.TrimSpace(output))
	}
	return nil
}

func registry(directory string, version string, size uint64) error {
	self := filepath.Join(directory, uninstaller)
	values := [][3]string{
		{"DisplayName", "REG_SZ", appName},
		{"DisplayVersion", "REG_SZ", version},
		{"Publisher", "REG_SZ", "ProkBot (self-hosted Grok Bot)"},
		{"InstallLocation", "REG_SZ", directory},
		{"DisplayIcon", "REG_SZ", filepath.Join(directory, exeName) + ",0"},
		{"UninstallString", "REG_SZ", `"` + self + `" --uninstall`},
		{"QuietUninstallString", "REG_SZ", `"` + self + `" --uninstall /S`},
		{"NoModify", "REG_DWORD", "1"},
		{"NoRepair", "REG_DWORD", "1"},
		{"EstimatedSize", "REG_DWORD", fmt.Sprint(size / 1024)},
	}
	for _, value := range values {
		if err := run("reg.exe", "add", registryKey, "/v", value[0], "/t", value[1], "/d", value[2], "/f"); err != nil {
			return err
		}
	}
	return nil
}

// Shortcuts are written by the shell's own COM object; paths travel in the environment.
func shortcuts(directory string, desktop bool) error {
	script := `$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$targets = @($env:GB_START_MENU)
if ($env:GB_DESKTOP -eq '1') { $targets += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Grok Bot Local.lnk' }
foreach ($path in $targets) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if ($item -and ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) { continue }
  $link = $shell.CreateShortcut($path)
  if ($item -and $link.TargetPath -ne $env:GB_TARGET) { continue }
  $link.TargetPath = $env:GB_TARGET
  $link.WorkingDirectory = $env:GB_DIRECTORY
  $link.IconLocation = "$($env:GB_TARGET),0"
  $link.Description = 'Grok Bot Local'
  $link.Save()
}`
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	flag := "0"
	if desktop {
		flag = "1"
	}
	command.Env = append(os.Environ(), "GB_START_MENU="+startMenuShortcut(), "GB_DESKTOP="+flag,
		"GB_TARGET="+filepath.Join(directory, exeName), "GB_DIRECTORY="+directory)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("shortcuts: %v: %s", err, bytes.TrimSpace(output))
	}
	return nil
}

// removeIntegration deletes shortcuts and the link handler only when they point into
// this installation; a portable copy elsewhere keeps its own.
func removeIntegration(directory string) error {
	script := `$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
foreach ($path in @($env:GB_START_MENU, (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Grok Bot Local.lnk'))) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if ($item -and !$item.PSIsContainer -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $shell.CreateShortcut($path).TargetPath -eq $env:GB_TARGET) {
    Remove-Item -LiteralPath $path -Force
  }
}
$handler = 'HKCU:\Software\Classes\grokbot-local'
$command = (Get-ItemProperty -LiteralPath "$handler\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
if ($command -and $command.StartsWith(('"' + $env:GB_TARGET + '" '), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $handler -Recurse -Force }`
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	command.Env = append(os.Environ(), "GB_START_MENU="+startMenuShortcut(), "GB_TARGET="+filepath.Join(directory, exeName))
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("shortcuts: %v: %s", err, bytes.TrimSpace(output))
	}
	return nil
}

type shellIntegration struct {
	install   func(directory, version string, size uint64, newInstall bool) error
	uninstall func(directory string) error
}

var windowsShell = shellIntegration{
	install: func(directory, version string, size uint64, newInstall bool) error {
		if err := registry(directory, version, size); err != nil {
			return err
		}
		return shortcuts(directory, newInstall)
	},
	uninstall: func(directory string) error {
		if err := removeIntegration(directory); err != nil {
			return err
		}
		if strings.EqualFold(registryString(strings.TrimPrefix(registryKey, `HKCU\`), "InstallLocation"), directory) {
			return run("reg.exe", "delete", registryKey, "/f")
		}
		return nil
	},
}

func install(self, directory, version string, shell shellIntegration) error {
	return installTo(self, directory, version, shell, installOptions{})
}

func installTo(self, directory, version string, shell shellIntegration, options installOptions) error {
	_, err := installToGuided(self, directory, version, shell, options, true, nil)
	return err
}

func installToGuided(self, directory, version string, shell shellIntegration, options installOptions, confirmFirst bool, onProgress func(int, string)) (bool, error) {
	old, _, err := inspectDirectory(directory, true)
	if err != nil {
		return false, err
	}
	if err := options.checkTarget(directory, old); err != nil {
		return false, err
	}
	data, err := readPayload(self)
	if err != nil {
		return false, err
	}
	defer data.file.Close()
	if confirmFirst && !ask(text(fmt.Sprintf("安装 %s %s 到：\n%s\n\n已有的配对和设置会保留。", appName, version, directory),
		fmt.Sprintf("Install %s %s to:\n%s\n\nExisting pairing and settings are kept.", appName, version, directory)), mbIconInfo) {
		return false, nil
	}
	if proceed, err := waitUntilClosed(directory); !proceed {
		return false, err
	}
	var window *asyncProgress
	if onProgress == nil {
		window = showProgress(text("正在安装 Grok Bot Local…", "Installing Grok Bot Local…"))
		defer window.close()
	}
	reportProgress := func(pct int, msg string) {
		if onProgress != nil {
			onProgress(pct, msg)
		} else if window != nil {
			window.set(msg)
		}
	}
	var size uint64
	err = transactInstallation(directory, func(stage string) error {
		size, err = extract(data, stage, func(done, total int) {
			if done%8 == 0 || done == total {
				pct := done * 75 / total
				msg := text(fmt.Sprintf("正在安装 Grok Bot Local… %d%%", done*100/total), fmt.Sprintf("Installing Grok Bot Local… %d%%", done*100/total))
				reportProgress(pct, msg)
			}
		})
		if err != nil {
			return err
		}
		reportProgress(78, text("正在校验并写入安装文件…", "Verifying and writing files…"))
		stub, err := os.OpenFile(filepath.Join(stage, uninstaller), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
		if err != nil {
			return err
		}
		_, err = io.CopyN(stub, io.NewSectionReader(data.file, 0, data.offset), data.offset)
		return errors.Join(err, stub.Close())
	}, func(upgrade, sideBySide bool) error {
		if sideBySide {
			return nil // Preserve the baseline installer registration and shortcuts.
		}
		reportProgress(90, text("正在创建快捷方式…", "Creating shortcuts…"))
		desktop := !upgrade
		if options.desktopShortcut != nil {
			desktop = *options.desktopShortcut
		}
		if err := shell.install(directory, version, size, desktop); err != nil {
			return fmt.Errorf("Windows registration or shortcuts may be incomplete: %w", err)
		}
		return nil
	}, options)
	if err != nil {
		return false, err
	}
	if onProgress != nil {
		return true, nil
	}
	window.close()
	if options.legacy != "" || (old != nil && old.LegacyFrom != "") {
		tell(fmt.Sprintf(text("并行安装完成。请先退出另一版本，再打开：\n%s\n配对和设置沿用原配置。", "Side-by-side installation complete. Quit the other version, then open:\n%s\nExisting pairing and settings are shared."), filepath.Join(directory, exeName)), mbOK|mbIconInfo)
		return true, nil
	}
	if !silent && ask(text("安装完成。现在打开 Grok Bot Local？", "Installation complete. Open Grok Bot Local now?"), mbIconInfo) {
		command := exec.Command(filepath.Join(directory, exeName))
		command.Dir = directory
		command.Start()
	}
	return true, nil
}

// registryString reads a REG_SZ value below HKCU as UTF-16; reg.exe output uses the
// console code page and cannot carry every path.
func registryString(subkey, value string) string {
	const currentUser, stringType = 0x80000001, 0x2
	key, _ := syscall.UTF16PtrFromString(subkey)
	name, _ := syscall.UTF16PtrFromString(value)
	var size uint32
	if result, _, _ := regGetValue.Call(currentUser, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(name)), stringType,
		0, 0, uintptr(unsafe.Pointer(&size))); result != 0 || size == 0 {
		return ""
	}
	buffer := make([]uint16, size/2+1)
	if result, _, _ := regGetValue.Call(currentUser, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(name)), stringType,
		0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size))); result != 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer)
}

// installedDirectory prefers the uninstaller's own folder, then the recorded location.
func installedDirectory(self string) string {
	if strings.EqualFold(filepath.Base(self), uninstaller) {
		return filepath.Dir(self)
	}
	if location := registryString(strings.TrimPrefix(registryKey, `HKCU\`), "InstallLocation"); location != "" {
		return location
	}
	return defaultDirectory()
}

func uninstall(self, directory string, shell shellIntegration, worker bool) error {
	if worker && strings.EqualFold(filepath.Dir(self), filepath.Clean(os.TempDir())) && strings.HasPrefix(filepath.Base(self), "grokbot-uninstall-") {
		defer cleanupWorker(self)
	}
	if _, _, err := inspectDirectory(directory, false); err != nil {
		return err
	}
	// The uninstaller lives inside the directory it removes; continue from a temporary copy.
	if strings.EqualFold(filepath.Dir(self), filepath.Clean(directory)) {
		data, err := os.ReadFile(self)
		if err != nil {
			return err
		}
		copy, err := os.CreateTemp(os.TempDir(), "grokbot-uninstall-*.exe")
		if err != nil {
			return err
		}
		_, err = copy.Write(data)
		if err = errors.Join(err, copy.Close()); err != nil {
			return errors.Join(err, os.Remove(copy.Name()))
		}
		args := []string{"--uninstall-from", directory}
		if silent {
			args = append(args, "/S")
		}
		command := exec.Command(copy.Name(), args...)
		// Windows locks a process's working directory; the caller may be inside the installation.
		command.Dir = filepath.Dir(copy.Name())
		if err := command.Start(); err != nil {
			return errors.Join(err, os.Remove(copy.Name()))
		}
		return nil
	}
	if !ask(text("卸载 Grok Bot Local？", "Uninstall Grok Bot Local?"), mbIconWarning|mbDefButton2) && !silent {
		return nil
	}
	if proceed, err := waitUntilClosed(directory); !proceed {
		return err
	}
	if err := transactInstallation(directory, nil, func(_, sideBySide bool) error {
		if sideBySide {
			return nil
		}
		if err := shell.uninstall(directory); err != nil {
			return fmt.Errorf("Windows registration or shortcuts may be incomplete: %w", err)
		}
		return nil
	}, installOptions{}); err != nil {
		return err
	}
	tell(text("Grok Bot Local 已卸载。已保留配对、设置及个人文件。", "Grok Bot Local has been uninstalled. Pairing, settings and personal files have been kept."), mbOK|mbIconInfo)
	return nil
}

func cleanupWorker(self string) {
	cleanup := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		`Wait-Process -Id $env:GB_PARENT -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $env:GB_TEMP_UNINSTALLER -Force`)
	cleanup.Env = append(os.Environ(), "GB_TEMP_UNINSTALLER="+self, fmt.Sprintf("GB_PARENT=%d", os.Getpid()))
	cleanup.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cleanup.Start()
}

func main() {
	language, _, _ := uiLanguage.Call()
	chinese = language&0x3ff == 0x04
	self, err := os.Executable()
	if err != nil {
		tell(err.Error(), mbIconError)
		os.Exit(1)
	}
	var relaunch bool
	directory, mode, version := defaultDirectory(), "install", "0.71.2"
	worker, migrate, customDir := false, false, false
	if strings.EqualFold(filepath.Base(self), uninstaller) {
		mode, directory = "uninstall", filepath.Dir(self)
	}
	for index := 1; index < len(os.Args); index++ {
		argument := os.Args[index]
		switch {
		case strings.EqualFold(argument, "/S"):
			silent = true
		case strings.EqualFold(argument, "/LAUNCH"), argument == "--launch":
			relaunch = true
		case argument == "--migrate-legacy":
			migrate = true
		case strings.HasPrefix(strings.ToUpper(argument), "/D="):
			// As with NSIS, /D= comes last and may contain unquoted spaces.
			directory = strings.Join(append([]string{argument[3:]}, os.Args[index+1:]...), " ")
			customDir = true
			index = len(os.Args)
		case argument == "--uninstall":
			mode, directory = "uninstall", installedDirectory(self)
		case argument == "--uninstall-from" && index+1 < len(os.Args):
			mode, directory = "uninstall", os.Args[index+1]
			worker = true
			index++
		case strings.HasPrefix(argument, "--version="):
			version = strings.TrimPrefix(argument, "--version=")
		}
	}
	if mode == "install" && !customDir {
		if saved := strings.TrimRight(filepath.FromSlash(registryString(strings.TrimPrefix(registryKey, `HKCU\`), "InstallLocation")), `\`); saved != "" && checkLocation(saved) == nil {
			directory = saved
		}
	}
	directory = strings.TrimRight(filepath.FromSlash(directory), `\`)
	if err := checkLocation(directory); err != nil {
		tell(err.Error(), mbIconError)
		os.Exit(1)
	}
	if mode == "install" {
		if data, err := readPayload(self); err == nil {
			if embedded, ok := embeddedVersion(data); ok {
				version = embedded
			}
			data.file.Close()
		}
		if !silent && !migrate {
			err = runInstallWizard(self, filepath.Clean(directory), version, windowsShell, false)
		} else {
			err = installEntry(self, filepath.Clean(directory), version, windowsShell, migrate)
			if err == nil && relaunch {
				targetExe := filepath.Join(filepath.Clean(directory), exeName)
				cmd := exec.Command(targetExe)
				cmd.Dir = filepath.Clean(directory)
				_ = cmd.Start()
			}
		}
	} else if migrate {
		err = errors.New("--migrate-legacy requires an installer, not an uninstaller")
	} else {
		err = uninstall(self, filepath.Clean(directory), windowsShell, worker)
	}
	if err != nil {
		if errors.Is(err, errInUse) {
			tell(text("Grok Bot Local 正在运行，请先退出。", errInUse.Error()), mbIconError)
			os.Exit(3)
		}
		tell(text("操作未完成：", "The operation did not finish: ")+err.Error(), mbIconError)
		os.Exit(1)
	}
}

// The patcher records the client version as the zip comment.
func embeddedVersion(data *payload) (string, bool) {
	reader, err := zip.NewReader(io.NewSectionReader(data.file, data.offset, data.size), data.size)
	if err != nil || reader.Comment == "" {
		return "", false
	}
	return reader.Comment, true
}
