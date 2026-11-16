//go:build android

package main

import (
	"net"
	"os"
	"strings"

	"tailscale.com/net/netmon"
)

func init() {
	// Android 14+ delivers Conscrypt root certificates via APEX; Go's crypto/x509 only scans
	// /system/etc/security/cacerts and /data/misc/keychain/certs-added unless SSL_CERT_DIR is set.
	if os.Getenv("SSL_CERT_DIR") == "" {
		_ = os.Setenv("SSL_CERT_DIR", strings.Join([]string{
			"/apex/com.android.conscrypt/cacerts",
			"/system/etc/security/cacerts",
			"/data/misc/keychain/certs-added",
		}, ":"))
	}
	// Android SDK 30+ denies NETLINK_ROUTE to app UIDs and GOOS=android cgo builds skip
	// tailscale.com/feature/androidbin's hook. Provide a UDP-probed interface list for netmon.
	netmon.RegisterInterfaceGetter(androidInterfaces)
	netmon.UpdateLastKnownDefaultRouteInterface("android")
}

// androidInterfaces builds a synthetic "android" netmon interface from non-netlink outbound UDP route probes.
func androidInterfaces() ([]netmon.Interface, error) {
	addrs := probeLocalAddresses()
	if len(addrs) == 0 {
		netmon.UpdateLastKnownDefaultRouteInterface("")
		return nil, nil
	}
	netmon.UpdateLastKnownDefaultRouteInterface("android")
	return []netmon.Interface{{
		Interface: &net.Interface{
			Index: 1,
			MTU:   1500,
			Name:  "android",
			Flags: net.FlagUp | net.FlagRunning,
		},
		AltAddrs: addrs,
	}}, nil
}

func probeLocalAddresses() []net.Addr {
	var addrs []net.Addr
	seen := make(map[string]struct{})
	addProbe := func(network string, targets ...string) {
		for _, target := range targets {
			conn, err := net.Dial(network, target)
			if err != nil {
				continue
			}
			local, _ := conn.LocalAddr().(*net.UDPAddr)
			_ = conn.Close()
			if local == nil || local.IP == nil || local.IP.IsUnspecified() || local.IP.IsLoopback() {
				continue
			}
			ip := local.IP
			bits := 128
			if ip4 := ip.To4(); ip4 != nil {
				ip = ip4
				bits = 32
			}
			key := ip.String()
			if _, exists := seen[key]; exists {
				return
			}
			seen[key] = struct{}{}
			addrs = append(addrs, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			return
		}
	}
	addProbe("udp4", "8.8.8.8:53", "192.168.0.1:53", "10.0.0.1:53", "172.16.0.1:53")
	addProbe("udp6", "[2001:4860:4860::8888]:53")
	return addrs
}
