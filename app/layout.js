import "./globals.css";

export const metadata = {
  title: "Roof & Siding Estimator",
  description: "Measure roof (shingles) and siding from imagery, and view the real house in 3D.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
