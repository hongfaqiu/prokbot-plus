#!/usr/bin/env python3
"""Build libgroktailcat.so and libgroktailcatjni.so for Android jniLibs."""
import argparse
import os
from pathlib import Path
import platform
import subprocess

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ABIS = ['arm64-v8a']
ABI_CONFIG = {
    'arm64-v8a': ('arm64', 'aarch64-linux-android'),
    'armeabi-v7a': ('arm', 'armv7a-linux-androideabi'),
    'x86_64': ('amd64', 'x86_64-linux-android'),
}
TAGS = (
    'ts_omit_ssh,ts_omit_logtail,ts_omit_netlog,ts_omit_capture,'
    'ts_omit_clientmetrics,ts_omit_usermetrics,ts_omit_portmapper,ts_omit_webclient'
)


def find_ndk() -> Path:
    if os.environ.get('ANDROID_NDK_HOME'):
        return Path(os.environ['ANDROID_NDK_HOME'])
    sdk = Path(os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or (Path.home() / 'Library/Android/sdk'))
    ndks = sorted((sdk / 'ndk').iterdir()) if (sdk / 'ndk').is_dir() else []
    if not ndks:
        raise RuntimeError(f'Android NDK not found under {sdk}/ndk')
    return ndks[-1]


def find_toolchain(ndk: Path) -> Path:
    prebuilt = ndk / 'toolchains/llvm/prebuilt'
    host_tag = 'darwin-x86_64' if platform.system() == 'Darwin' else 'linux-x86_64'
    candidate = prebuilt / host_tag
    if candidate.is_dir():
        return candidate / 'bin'
    dirs = [d for d in prebuilt.iterdir() if d.is_dir()]
    if not dirs:
        raise RuntimeError(f'NDK llvm prebuilt not found under {prebuilt}')
    return dirs[0] / 'bin'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--abi', action='append', choices=sorted(ABI_CONFIG), help='Target Android ABI (default: arm64-v8a)')
    parser.add_argument('--api', type=int, default=28)
    args = parser.parse_args()
    abis = args.abi or DEFAULT_ABIS

    ndk = find_ndk()
    toolchain = find_toolchain(ndk)
    jni_libs = ROOT / 'android/shell/app/src/main/jniLibs'
    jni_src = ROOT / 'android/shell/app/src/main/cpp/tailcat_jni.c'
    tailcat_dir = ROOT / 'host/network/tailcat'

    for abi in abis:
        goarch, triple = ABI_CONFIG[abi]
        cc = toolchain / f'{triple}{args.api}-clang'
        if not cc.exists():
            raise RuntimeError(f'NDK compiler missing: {cc}')
        out_dir = jni_libs / abi
        out_dir.mkdir(parents=True, exist_ok=True)
        go_so = out_dir / 'libgroktailcat.so'
        go_header = out_dir / 'libgroktailcat.h'

        env = os.environ.copy()
        env.update(
            GOOS='android',
            GOARCH=goarch,
            CGO_ENABLED='1',
            CC=str(cc),
            CGO_LDFLAGS='-Wl,-z,max-page-size=16384 -Wl,-soname,libgroktailcat.so',
        )
        if goarch == 'arm':
            env['GOARM'] = '7'

        subprocess.run(
            [
                'go', 'build', '-trimpath', '-tags', TAGS,
                '-buildmode=c-shared',
                '-ldflags=-s -w',
                '-o', str(go_so), './mobile',
            ],
            cwd=tailcat_dir,
            env=env,
            check=True,
        )

        jni_so = out_dir / 'libgroktailcatjni.so'
        subprocess.run(
            [
                str(cc), '-shared', '-fPIC', '-O2',
                '-Wl,-z,max-page-size=16384',
                '-Wl,-soname,libgroktailcatjni.so',
                '-I', str(out_dir),
                str(jni_src), '-L', str(out_dir), '-lgroktailcat',
                '-llog', '-o', str(jni_so),
            ],
            check=True,
        )
        if go_header.exists():
            go_header.unlink()
        print(f'Built {abi}: {go_so.stat().st_size // 1024} KiB + {jni_so.stat().st_size // 1024} KiB')


if __name__ == '__main__':
    main()
