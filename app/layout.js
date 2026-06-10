import "./globals.css";

export const metadata = {
  title: "Home Measurement",
  description: "Geocode an address, measure the roof/footprint, view it in 3D.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
