/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true
  },
  // Only apply "output: 'export'" when not in development mode
  ...(process.env.NODE_ENV !== 'development' && { output: 'export' }),
  ...(process.env.NODE_ENV !== 'development' && { distDir: '../dist/dashboard' })
}

module.exports = nextConfig
