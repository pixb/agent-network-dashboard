import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AppShell } from "./components/AppShell";
import { NetworkProvider } from "./lib/network-context";
import { ThemeProvider } from "./components/ThemeSwitcher";
import { PwaInstaller } from "./components/PwaInstaller";

// #217 D1 (Vincent: OpenWebUI-style serious-product feel): UI text is
// sans; mono stays for code blocks, IDs and logs via .font-mono.
// 字体自托管：Geist / Geist Mono 的 latin 子集（可变字重 100–900）随仓库走。
// 原来是 next/font/google —— 构建时必须能访问 fonts.googleapis.com 与
// fonts.gstatic.com；本机 DNS 把 gstatic 指到不可达的 IP 时 `next build` 直接失败。
// 自托管后构建不依赖外网，产物与线上用同一份文件。
const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Agent Network Dashboard",
  description: "Real-time monitoring dashboard for Agent Network nodes via CommHub",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Agent Network",
  },
  // R26 of #190: Next.js 16 renders `mobile-web-app-capable` (the modern
  // standardized meta) but NOT the legacy `apple-mobile-web-app-capable`.
  // iOS Safari < 16.4 only checks the apple-prefixed name; without it,
  // the dashboard won't install as a web app on those iOS versions and
  // the statusBarStyle + apple-touch-icon (R24) are silently ignored.
  // Emit the legacy alias via metadata.other for back-compat.
  other: {
    'apple-mobile-web-app-capable': 'yes',
  },
  // R24 of #190: appleWebApp.capable above declares this is an iOS web
  // app, but only `icon` was specified, leaving iOS Safari to fall back
  // to a generic icon on Add-to-Home-Screen. iOS 15+ accepts SVG via
  // `rel="apple-touch-icon" type="image/svg+xml"`; older iOS will fall
  // back to the manifest icons (added R23) and then the generic. Reuse
  // the existing sleep2agi-logo.svg — no new asset shipped.
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/sleep2agi-logo.svg', type: 'image/svg+xml' }],
    shortcut: '/favicon.svg',
  },
  openGraph: {
    title: "Agent Network Dashboard",
    description: "Real-time monitoring dashboard for Agent Network nodes",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: "#0b0b0d",
  // R25 of #190: metadata.appleWebApp.statusBarStyle above is
  // "black-translucent", which renders the iOS status bar as a
  // transparent overlay above the page (rather than reserving its own
  // strip). Without viewportFit: "cover" the resulting safe-area-inset
  // env() values resolve to 0, so the HealthBanner gets occluded by
  // the clock/battery row when the user opens the installed PWA.
  viewportFit: "cover",
};

// Inline pre-paint script to apply persisted theme before React hydrates,
// preventing a white flash on light/mint themes for users who already set it.
const themeBootScript = `
try {
  var t = localStorage.getItem('anet-theme') || 'cyber';
  var el = document.documentElement;
  // 「跟随系统」要在首帧前就解析掉，否则会先按默认深色画一帧再跳成浅色。
  if (t === 'system') {
    t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'cyber' : 'light';
  }
  // slack 是 light 主题上的皮肤：两头都要在首帧前设好，否则会先闪一下
  // 普通浅色再切到 Slack 配色（applyTheme 的同一套约定）。
  if (t === 'slack') {
    el.setAttribute('data-theme', 'light');
    el.setAttribute('data-skin', 'slack');
  } else {
    el.setAttribute('data-theme', t);
    el.removeAttribute('data-skin');
  }
  // 界面密度也要在首帧前生效，否则会先按标准行高画一帧再跳（列表会「抖一下」）。
  var f = localStorage.getItem('anet-font-scale');
  if (f === 'small' || f === 'large' || f === 'xlarge') {
    var map = { small: 0.9, large: 1.15, xlarge: 1.3 };
    el.setAttribute('data-font', f);
    el.style.setProperty('--font-scale', String(map[f]));
  }
  // 军团配色：属性给 CSS/断言用，画布本身读 localStorage（两处保持一致）。
  el.setAttribute('data-legion-palette', localStorage.getItem('anet-legion-palette') === 'warm' ? 'warm' : 'deep');
  var d = localStorage.getItem('anet-density');
  if (d === 'compact' || d === 'comfortable') el.setAttribute('data-density', d);
} catch (e) {}
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="cyber"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="min-h-full" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
        <ThemeProvider>
          <NetworkProvider>
            <PwaInstaller />
            <AppShell>{children}</AppShell>
          </NetworkProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
