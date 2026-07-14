import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Inter: tipografía operativa de máxima legibilidad para uso diario;
// la identidad Es Fumeral la llevan el color y el espaciado, no la fuente
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mi Bodega · Es Fumeral",
  description: "Gestión de inventario de vinos · Es Fumeral, Ibiza",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Mi Bodega",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f8f5f0",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
