import type { Metadata, Viewport } from "next";
import { Montserrat, Instrument_Serif } from "next/font/google";
import "./globals.css";

// Tipografías de la marca Es Fumeral (esfumeral.com):
// Montserrat para texto/UI e Instrument Serif para titulares
const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
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
    <html lang="es" className={`${montserrat.variable} ${instrumentSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
