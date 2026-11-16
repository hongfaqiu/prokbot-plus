//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	gdi32                = syscall.NewLazyDLL("gdi32.dll")
	shell32              = syscall.NewLazyDLL("shell32.dll")
	ole32                = syscall.NewLazyDLL("ole32.dll")
	comctl32             = syscall.NewLazyDLL("comctl32.dll")
	registerClassExW     = user32.NewProc("RegisterClassExW")
	defWindowProcW       = user32.NewProc("DefWindowProcW")
	getMessageW          = user32.NewProc("GetMessageW")
	postMessageW         = user32.NewProc("PostMessageW")
	sendMessageW         = user32.NewProc("SendMessageW")
	postQuitMessage      = user32.NewProc("PostQuitMessage")
	isDialogMessageW     = user32.NewProc("IsDialogMessageW")
	enableWindow         = user32.NewProc("EnableWindow")
	getWindowTextLengthW = user32.NewProc("GetWindowTextLengthW")
	getWindowTextW       = user32.NewProc("GetWindowTextW")
	getDlgItem           = user32.NewProc("GetDlgItem")
	getSystemMenu        = user32.NewProc("GetSystemMenu")
	enableMenuItem       = user32.NewProc("EnableMenuItem")
	loadCursorW          = user32.NewProc("LoadCursorW")
	loadIconW            = user32.NewProc("LoadIconW")
	getSysColor          = user32.NewProc("GetSysColor")
	getSysColorBrush     = user32.NewProc("GetSysColorBrush")
	setProcessDPIAware   = user32.NewProc("SetProcessDPIAware")
	getDC                = user32.NewProc("GetDC")
	releaseDC            = user32.NewProc("ReleaseDC")
	getDeviceCaps        = gdi32.NewProc("GetDeviceCaps")
	createFontW          = gdi32.NewProc("CreateFontW")
	deleteObject         = gdi32.NewProc("DeleteObject")
	setBkMode            = gdi32.NewProc("SetBkMode")
	setTextColor         = gdi32.NewProc("SetTextColor")
	getModuleHandleW     = kernel32.NewProc("GetModuleHandleW")
	mulDiv               = kernel32.NewProc("MulDiv")
	initCommonControlsEx = comctl32.NewProc("InitCommonControlsEx")
	shBrowseForFolderW   = shell32.NewProc("SHBrowseForFolderW")
	shGetPathFromIDListW = shell32.NewProc("SHGetPathFromIDListW")
	coInitializeEx       = ole32.NewProc("CoInitializeEx")
	coUninitialize       = ole32.NewProc("CoUninitialize")
	coTaskMemFree        = ole32.NewProc("CoTaskMemFree")
)

const (
	wmDestroy        = 0x0002
	wmClose          = 0x0010
	wmSetFont        = 0x0030
	wmCommand        = 0x0111
	wmSysCommand     = 0x0112
	wmCtlColorStatic = 0x0138
	wmApp            = 0x8000
	wmSetProgress    = wmApp + 1
	wmInstallDone    = wmApp + 2
	wmProgressText   = wmApp + 3
	wmCloseProgress  = wmApp + 4

	scClose          = 0xF060
	mfByCommand      = 0x0000
	mfGrayed         = 0x0001
	mfEnabled        = 0x0000
	bnClicked        = 0
	bmGetCheck       = 0x00F0
	bmSetCheck       = 0x00F1
	bstChecked       = 1
	pbmSetPos        = 0x0402
	pbmSetRange32    = 0x0406
	emSetLimitText   = 0x00C5
	wsOverlapped     = 0x00000000
	wsCaption        = 0x00C00000
	wsSysMenu        = 0x00080000
	wsMinimizeBox    = 0x00020000
	wsChild          = 0x40000000
	wsVisible        = 0x10000000
	wsTabStop        = 0x00010000
	wsBorder         = 0x00800000
	wsExClientEdge   = 0x0200
	esAutoHScroll    = 0x0080
	ssLeft           = 0x0000
	ssNoPrefix       = 0x0080
	bsPushButton     = 0x0000
	bsDefPushButton  = 0x0001
	bsAutoCheckBox   = 0x0003
	pbsSmooth        = 0x01
	colorBtnFace     = 15
	colorWindowText  = 8
	transparentMode  = 1
	logPixelsY       = 90
	idcArrow         = 32512
	idiApplication   = 32512
	bffmInitialized  = 1
	bffmSetSelection = 0x0400 + 103
	bifReturnOnlyFs  = 0x0001
	bifEditBox       = 0x0010
	bifNewDialog     = 0x0040

	idOk          = 1
	idCancel      = 2
	idPathEdit    = 101
	idBrowseBtn   = 102
	idDesktopChk  = 103
	idStatusLbl   = 104
	idProgressBar = 105
)

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     syscall.Handle
	hIcon         syscall.Handle
	hCursor       syscall.Handle
	hbrBackground syscall.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       syscall.Handle
}

type winMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	ptX     int32
	ptY     int32
}

type initCommonControlsExStruct struct {
	dwSize uint32
	dwICC  uint32
}

type browseInfoW struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName *uint16
	lpszTitle      *uint16
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

func initGUI() int32 {
	setProcessDPIAware.Call()
	icc := initCommonControlsExStruct{dwSize: uint32(unsafe.Sizeof(initCommonControlsExStruct{})), dwICC: 0x20}
	initCommonControlsEx.Call(uintptr(unsafe.Pointer(&icc)))
	hdc, _, _ := getDC.Call(0)
	dpi := int32(96)
	if hdc != 0 {
		v, _, _ := getDeviceCaps.Call(hdc, logPixelsY)
		if v >= 96 {
			dpi = int32(v)
		}
		releaseDC.Call(0, hdc)
	}
	return dpi
}

func createGUIFont(dpi int32, pt int32, weight int32) uintptr {
	height, _, _ := mulDiv.Call(uintptr(-pt), uintptr(dpi), 72)
	faceName := "Segoe UI"
	if chinese {
		faceName = "Microsoft YaHei UI"
	}
	face, _ := syscall.UTF16PtrFromString(faceName)
	font, _, _ := createFontW.Call(
		height, 0, 0, 0, uintptr(weight), 0, 0, 0,
		1, 0, 0, 5, 0, uintptr(unsafe.Pointer(face)),
	)
	return font
}

func createControl(exStyle uintptr, className, title string, style uintptr, x, y, w, h int32, parent, id, hInstance, font uintptr) uintptr {
	cls, _ := syscall.UTF16PtrFromString(className)
	txt, _ := syscall.UTF16PtrFromString(title)
	hwnd, _, _ := createWindow.Call(
		exStyle,
		uintptr(unsafe.Pointer(cls)),
		uintptr(unsafe.Pointer(txt)),
		style,
		uintptr(x), uintptr(y), uintptr(w), uintptr(h),
		parent, id, hInstance, 0,
	)
	if hwnd != 0 && font != 0 {
		sendMessageW.Call(hwnd, wmSetFont, font, 1)
	}
	return hwnd
}

func getControlText(hwnd uintptr) string {
	length, _, _ := getWindowTextLengthW.Call(hwnd)
	if length == 0 {
		return ""
	}
	buf := make([]uint16, length+1)
	getWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), length+1)
	return syscall.UTF16ToString(buf)
}

func setControlText(hwnd uintptr, value string) {
	txt, _ := syscall.UTF16PtrFromString(value)
	setWindowText.Call(hwnd, uintptr(unsafe.Pointer(txt)))
}

func normalizeWizardDir(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	return strings.TrimRight(filepath.FromSlash(trimmed), `\`)
}

func browseForInstallFolder(owner uintptr, current string) string {
	hr, _, _ := coInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
	if hr == 0 || hr == 1 {
		defer coUninitialize.Call()
	}
	initial := normalizeWizardDir(current)
	if initial != "" {
		if _, err := os.Stat(initial); err != nil {
			parent := filepath.Dir(initial)
			if _, perr := os.Stat(parent); perr == nil {
				initial = parent
			}
		}
	}
	initialPtr, _ := syscall.UTF16PtrFromString(initial)
	cb := syscall.NewCallback(func(hwnd uintptr, uMsg uint32, _, _ uintptr) uintptr {
		if uMsg == bffmInitialized && initialPtr != nil && initial != "" {
			sendMessageW.Call(hwnd, bffmSetSelection, 1, uintptr(unsafe.Pointer(initialPtr)))
		}
		return 0
	})
	titlePtr, _ := syscall.UTF16PtrFromString(text("选择 Grok Bot Local 安装目录", "Choose Grok Bot Local installation folder"))
	displayBuf := make([]uint16, 32768)
	bi := browseInfoW{
		hwndOwner:      owner,
		pszDisplayName: &displayBuf[0],
		lpszTitle:      titlePtr,
		ulFlags:        bifReturnOnlyFs | bifEditBox | bifNewDialog,
		lpfn:           cb,
	}
	pidl, _, _ := shBrowseForFolderW.Call(uintptr(unsafe.Pointer(&bi)))
	runtime.KeepAlive(initialPtr)
	if pidl == 0 {
		return ""
	}
	defer coTaskMemFree.Call(pidl)
	pathBuf := make([]uint16, 32768)
	ok, _, _ := shGetPathFromIDListW.Call(pidl, uintptr(unsafe.Pointer(&pathBuf[0])))
	if ok == 0 {
		return ""
	}
	picked := strings.TrimRight(syscall.UTF16ToString(pathBuf), `\`)
	if picked == "" {
		return ""
	}
	if !strings.EqualFold(filepath.Base(picked), appName) {
		entries, err := os.ReadDir(picked)
		if err == nil && len(entries) > 0 && checkMarker(picked) != nil {
			if _, rErr := plainPath(filepath.Join(picked, receiptName)); errors.Is(rErr, os.ErrNotExist) {
				picked = filepath.Join(picked, appName)
			}
		}
	}
	return picked
}

type wizardState struct {
	self        string
	version     string
	shell       shellIntegration
	hwnd        uintptr
	dpi         int32
	fontRegular uintptr
	fontTitle   uintptr

	mu          sync.Mutex
	installing  bool
	progressPct int
	statusText  string
	installErr  error
	cancelled   bool
	finalDir    string
	sideBySide  bool
	launched    bool
}

func (w *wizardState) setControlsEnabled(enabled bool) {
	flag := uintptr(0)
	if enabled {
		flag = 1
	}
	for _, id := range []uintptr{idPathEdit, idBrowseBtn, idDesktopChk, idOk, idCancel} {
		ctrl, _, _ := getDlgItem.Call(w.hwnd, id)
		if ctrl != 0 {
			enableWindow.Call(ctrl, flag)
		}
	}
	sysMenu, _, _ := getSystemMenu.Call(w.hwnd, 0)
	if sysMenu != 0 {
		state := uintptr(mfByCommand | mfGrayed)
		if enabled {
			state = uintptr(mfByCommand | mfEnabled)
		}
		enableMenuItem.Call(sysMenu, scClose, state)
	}
}

func (w *wizardState) postProgress(pct int, status string) {
	w.mu.Lock()
	w.progressPct = pct
	w.statusText = status
	w.mu.Unlock()
	if w.hwnd != 0 {
		postMessageW.Call(w.hwnd, wmSetProgress, 0, 0)
	}
}

func (w *wizardState) applyProgress() {
	w.mu.Lock()
	pct := w.progressPct
	status := w.statusText
	w.mu.Unlock()
	if bar, _, _ := getDlgItem.Call(w.hwnd, idProgressBar); bar != 0 {
		sendMessageW.Call(bar, pbmSetPos, uintptr(pct), 0)
	}
	if lbl, _, _ := getDlgItem.Call(w.hwnd, idStatusLbl); lbl != 0 {
		setControlText(lbl, status)
	}
}

func (w *wizardState) startInstall() {
	edit, _, _ := getDlgItem.Call(w.hwnd, idPathEdit)
	rawDir := getControlText(edit)
	chosenDir := normalizeWizardDir(rawDir)
	if err := checkLocation(chosenDir); err != nil {
		tell(text("安装路径无效：\n", "Invalid installation directory:\n")+err.Error(), mbIconError)
		return
	}
	chk, _, _ := getDlgItem.Call(w.hwnd, idDesktopChk)
	desktop := true
	if chk != 0 {
		checked, _, _ := sendMessageW.Call(chk, bmGetCheck, 0, 0)
		desktop = checked == bstChecked
	}

	w.mu.Lock()
	w.installing = true
	w.installErr = nil
	w.cancelled = false
	w.finalDir = chosenDir
	w.sideBySide = false
	w.mu.Unlock()

	w.setControlsEnabled(false)
	w.postProgress(0, text("正在准备安装…", "Preparing installation…"))

	go func() {
		finalDir, sideBySide, cancelled, err := runWizardInstall(w.self, chosenDir, w.version, w.shell, desktop, w.postProgress)
		w.mu.Lock()
		w.installing = false
		w.finalDir = finalDir
		w.sideBySide = sideBySide
		w.cancelled = cancelled
		w.installErr = err
		w.mu.Unlock()
		postMessageW.Call(w.hwnd, wmInstallDone, 0, 0)
	}()
}

func (w *wizardState) handleInstallDone() {
	w.mu.Lock()
	err := w.installErr
	cancelled := w.cancelled
	finalDir := w.finalDir
	sideBySide := w.sideBySide
	w.mu.Unlock()

	if err != nil {
		w.setControlsEnabled(true)
		w.postProgress(0, text("安装未完成", "Installation did not finish"))
		if errors.Is(err, errInUse) {
			tell(text("Grok Bot Local 正在运行，请先退出。", errInUse.Error()), mbIconError)
		} else {
			tell(text("操作未完成：", "The operation did not finish: ")+err.Error(), mbIconError)
		}
		return
	}
	if cancelled {
		w.setControlsEnabled(true)
		w.postProgress(0, text("已取消，可修改目录后重新安装", "Cancelled. Adjust the folder or click Cancel."))
		return
	}
	w.postProgress(100, text("安装完成", "Installation complete"))
	destroyWindow.Call(w.hwnd)
	if sideBySide {
		tell(fmt.Sprintf(text("并行安装完成。请先退出另一版本，再打开：\n%s\n配对和设置沿用原配置。",
			"Side-by-side installation complete. Quit the other version, then open:\n%s\nExisting pairing and settings are shared."), filepath.Join(finalDir, exeName)), mbOK|mbIconInfo)
		return
	}
	if ask(text("安装完成。现在打开 Grok Bot Local？", "Installation complete. Open Grok Bot Local now?"), mbIconInfo) {
		command := exec.Command(filepath.Join(finalDir, exeName))
		command.Dir = finalDir
		command.Start()
	}
}

func runInstallWizard(self, initialDir, version string, shell shellIntegration, migrate bool) (err error) {
	if migrate {
		return installEntry(self, initialDir, version, shell, true)
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	dpi := initGUI()
	scale := func(px int32) int32 { return px * dpi / 96 }

	hInstance, _, _ := getModuleHandleW.Call(0)
	fontTitle := createGUIFont(dpi, 11, 600)
	fontRegular := createGUIFont(dpi, 9, 400)
	defer func() {
		if fontTitle != 0 {
			deleteObject.Call(fontTitle)
		}
		if fontRegular != 0 {
			deleteObject.Call(fontRegular)
		}
	}()

	w := &wizardState{
		self:        self,
		version:     version,
		shell:       shell,
		dpi:         dpi,
		fontRegular: fontRegular,
		fontTitle:   fontTitle,
	}

	var wndProc uintptr
	wndProc = syscall.NewCallback(func(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
		switch msg {
		case wmCtlColorStatic:
			setBkMode.Call(wParam, transparentMode)
			c, _, _ := getSysColor.Call(colorWindowText)
			setTextColor.Call(wParam, c)
			brush, _, _ := getSysColorBrush.Call(colorBtnFace)
			return brush
		case wmSetProgress:
			w.applyProgress()
			return 0
		case wmInstallDone:
			w.handleInstallDone()
			return 0
		case wmCommand:
			id := wParam & 0xffff
			code := (wParam >> 16) & 0xffff
			if code == bnClicked {
				switch id {
				case idBrowseBtn:
					edit, _, _ := getDlgItem.Call(hwnd, idPathEdit)
					if picked := browseForInstallFolder(hwnd, getControlText(edit)); picked != "" {
						setControlText(edit, picked)
					}
					return 0
				case idOk:
					w.startInstall()
					return 0
				case idCancel:
					w.mu.Lock()
					busy := w.installing
					w.mu.Unlock()
					if !busy {
						destroyWindow.Call(hwnd)
					}
					return 0
				}
			}
		case wmClose:
			w.mu.Lock()
			busy := w.installing
			w.mu.Unlock()
			if !busy {
				destroyWindow.Call(hwnd)
			}
			return 0
		case wmDestroy:
			postQuitMessage.Call(0)
			return 0
		}
		res, _, _ := defWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
		return res
	})

	className, _ := syscall.UTF16PtrFromString("GrokBotLocalSetupWizard")
	cursor, _, _ := loadCursorW.Call(0, idcArrow)
	icon, _, _ := loadIconW.Call(0, idiApplication)
	wc := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   wndProc,
		hInstance:     syscall.Handle(hInstance),
		hIcon:         syscall.Handle(icon),
		hCursor:       syscall.Handle(cursor),
		hbrBackground: syscall.Handle(colorBtnFace + 1),
		lpszClassName: className,
		hIconSm:       syscall.Handle(icon),
	}
	registerClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	winW, winH := scale(520), scale(275)
	screenW, _, _ := systemMetrics.Call(0)
	screenH, _, _ := systemMetrics.Call(1)
	x := (int32(screenW) - winW) / 2
	y := (int32(screenH) - winH) / 2

	title := fmt.Sprintf(text("安装 %s %s", "Install %s %s"), appName, version)
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	style := uintptr(wsOverlapped | wsCaption | wsSysMenu | wsMinimizeBox | wsVisible)
	hwnd, _, _ := createWindow.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(titlePtr)),
		style,
		uintptr(x), uintptr(y), uintptr(winW), uintptr(winH),
		0, 0, hInstance, 0,
	)
	if hwnd == 0 {
		return installEntry(self, initialDir, version, shell, false)
	}
	w.hwnd = hwnd

	pad := scale(20)
	contentW := winW - scale(16) - pad*2
	createControl(0, "STATIC", fmt.Sprintf(text("欢迎安装 %s %s", "Welcome to %s %s Setup"), appName, version),
		wsChild|wsVisible|ssLeft|ssNoPrefix, pad, scale(16), contentW, scale(24), hwnd, 0, hInstance, fontTitle)
	createControl(0, "STATIC", text("选择安装位置（已有的配对和设置会自动保留）：", "Choose installation folder (existing pairing and settings are kept):"),
		wsChild|wsVisible|ssLeft|ssNoPrefix, pad, scale(44), contentW, scale(20), hwnd, 0, hInstance, fontRegular)

	browseW := scale(84)
	editW := contentW - browseW - scale(8)
	edit := createControl(wsExClientEdge, "EDIT", initialDir,
		wsChild|wsVisible|wsTabStop|esAutoHScroll, pad, scale(72), editW, scale(26), hwnd, idPathEdit, hInstance, fontRegular)
	if edit != 0 {
		sendMessageW.Call(edit, emSetLimitText, 32760, 0)
	}
	createControl(0, "BUTTON", text("浏览…", "Browse…"),
		wsChild|wsVisible|wsTabStop|bsPushButton, pad+editW+scale(8), scale(71), browseW, scale(28), hwnd, idBrowseBtn, hInstance, fontRegular)

	chk := createControl(0, "BUTTON", text("创建桌面快捷方式", "Create desktop shortcut"),
		wsChild|wsVisible|wsTabStop|bsAutoCheckBox, pad, scale(108), contentW, scale(22), hwnd, idDesktopChk, hInstance, fontRegular)
	if chk != 0 {
		sendMessageW.Call(chk, bmSetCheck, bstChecked, 0)
	}

	createControl(0, "STATIC", text("点击“安装”开始安装。", "Click Install to begin."),
		wsChild|wsVisible|ssLeft|ssNoPrefix, pad, scale(140), contentW, scale(20), hwnd, idStatusLbl, hInstance, fontRegular)
	bar := createControl(0, "msctls_progress32", "",
		wsChild|wsVisible|pbsSmooth, pad, scale(164), contentW, scale(18), hwnd, idProgressBar, hInstance, 0)
	if bar != 0 {
		sendMessageW.Call(bar, pbmSetRange32, 0, 100)
	}

	btnW, btnH := scale(88), scale(28)
	btnY := scale(198)
	createControl(0, "BUTTON", text("安装", "Install"),
		wsChild|wsVisible|wsTabStop|bsDefPushButton, pad+contentW-btnW*2-scale(8), btnY, btnW, btnH, hwnd, idOk, hInstance, fontRegular)
	createControl(0, "BUTTON", text("取消", "Cancel"),
		wsChild|wsVisible|wsTabStop|bsPushButton, pad+contentW-btnW, btnY, btnW, btnH, hwnd, idCancel, hInstance, fontRegular)

	var m winMsg
	for {
		ret, _, _ := getMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(ret) <= 0 {
			break
		}
		handled, _, _ := isDialogMessageW.Call(hwnd, uintptr(unsafe.Pointer(&m)))
		if handled == 0 {
			translateMessage.Call(uintptr(unsafe.Pointer(&m)))
			dispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}
	runtime.KeepAlive(wndProc)
	return nil
}

func runWizardInstall(self, dir, version string, shell shellIntegration, desktop bool, onProgress func(int, string)) (finalDir string, sideBySide bool, cancelled bool, err error) {
	opt := installOptions{desktopShortcut: &desktop}
	done, err := installToGuided(self, dir, version, shell, opt, false, onProgress)
	if err == nil {
		return dir, false, !done, nil
	}
	var legacy legacyInstallation
	if !errors.As(err, &legacy) {
		return dir, false, false, err
	}
	if !ask(fmt.Sprintf(text("保留旧安装 %s，在旁边安装新版本到 %s？\n两者共用已有的配对和设置，请先退出旧客户端。",
		"Keep the old installation at %s and install the new version alongside it at %s?\nBoth use the existing pairing and settings. Quit the old client first."), dir, siblingDirectory(dir)), mbIconInfo|mbDefButton2) {
		return dir, false, true, nil
	}
	if !legacyDirectory(dir) {
		return dir, false, false, fmt.Errorf("not a marker-only legacy installation: %s; /D= must name the old installation", dir)
	}
	target := siblingDirectory(dir)
	opt.legacy = dir
	done, err = installToGuided(self, target, version, shell, opt, false, onProgress)
	return target, true, !done, err
}

// asyncProgress keeps a dedicated UI thread responsive during non-wizard installs.
type asyncProgress struct {
	hwnd   uintptr
	mu     sync.Mutex
	text   string
	closed chan struct{}
}

func showAsyncProgress(message string) *asyncProgress {
	if silent {
		return &asyncProgress{}
	}
	ap := &asyncProgress{text: message, closed: make(chan struct{})}
	ready := make(chan uintptr, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(ap.closed)

		dpi := initGUI()
		scale := func(px int32) int32 { return px * dpi / 96 }
		font := createGUIFont(dpi, 9, 400)
		defer func() {
			if font != 0 {
				deleteObject.Call(font)
			}
		}()

		var wndProc uintptr
		wndProc = syscall.NewCallback(func(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
			switch msg {
			case wmCtlColorStatic:
				setBkMode.Call(wParam, transparentMode)
				c, _, _ := getSysColor.Call(colorWindowText)
				setTextColor.Call(wParam, c)
				brush, _, _ := getSysColorBrush.Call(colorBtnFace)
				return brush
			case wmProgressText:
				ap.mu.Lock()
				t := ap.text
				ap.mu.Unlock()
				if lbl, _, _ := getDlgItem.Call(hwnd, idStatusLbl); lbl != 0 {
					setControlText(lbl, t)
				}
				return 0
			case wmCloseProgress:
				destroyWindow.Call(hwnd)
				return 0
			case wmClose:
				return 0
			case wmDestroy:
				postQuitMessage.Call(0)
				return 0
			}
			res, _, _ := defWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
			return res
		})

		hInstance, _, _ := getModuleHandleW.Call(0)
		className, _ := syscall.UTF16PtrFromString("GrokBotLocalProgressWindow")
		wc := wndClassExW{
			cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
			lpfnWndProc:   wndProc,
			hInstance:     syscall.Handle(hInstance),
			hbrBackground: syscall.Handle(colorBtnFace + 1),
			lpszClassName: className,
		}
		registerClassExW.Call(uintptr(unsafe.Pointer(&wc)))

		width, height := scale(420), scale(96)
		screenW, _, _ := systemMetrics.Call(0)
		screenH, _, _ := systemMetrics.Call(1)
		titlePtr, _ := syscall.UTF16PtrFromString(appName)
		hwnd, _, _ := createWindow.Call(
			0x8, // WS_EX_TOPMOST
			uintptr(unsafe.Pointer(className)),
			uintptr(unsafe.Pointer(titlePtr)),
			uintptr(wsOverlapped|wsCaption|wsVisible),
			uintptr((int32(screenW)-width)/2), uintptr((int32(screenH)-height)/2),
			uintptr(width), uintptr(height),
			0, 0, hInstance, 0,
		)
		if hwnd != 0 {
			createControl(0, "STATIC", message,
				wsChild|wsVisible|0x1|0x200|ssNoPrefix,
				scale(12), scale(14), width-scale(32), scale(36), hwnd, idStatusLbl, hInstance, font)
		}
		ready <- hwnd
		if hwnd == 0 {
			return
		}
		var m winMsg
		for {
			ret, _, _ := getMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(ret) <= 0 {
				break
			}
			translateMessage.Call(uintptr(unsafe.Pointer(&m)))
			dispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
		runtime.KeepAlive(wndProc)
	}()
	ap.hwnd = <-ready
	return ap
}

func (p *asyncProgress) set(message string) {
	if p == nil || p.hwnd == 0 {
		return
	}
	p.mu.Lock()
	p.text = message
	p.mu.Unlock()
	postMessageW.Call(p.hwnd, wmProgressText, 0, 0)
}

func (p *asyncProgress) close() {
	if p == nil || p.hwnd == 0 {
		return
	}
	postMessageW.Call(p.hwnd, wmCloseProgress, 0, 0)
	<-p.closed
	p.hwnd = 0
}
