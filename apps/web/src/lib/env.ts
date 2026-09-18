export const env = {
  apiUrl:
    import.meta.env.VITE_API_URL ??
    // dev 下跟随页面实际来源的主机名（localhost 或 LAN/CGNAT IP 都行），
    // 这样从别的设备经 dev server 的 IP 打开也能正确打到 API，而不是去自己的 localhost。
    (import.meta.env.DEV ? `http://${window.location.hostname}:8787` : window.location.origin),
} as const
