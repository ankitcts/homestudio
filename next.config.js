/** @type {import('next').NextConfig} */
const nextConfig = {
  // The app uses imperative DOM setup (Google Maps + Three.js), so we keep
  // StrictMode off to avoid double-invoking the one-time init effect in dev.
  reactStrictMode: false,
};

module.exports = nextConfig;
