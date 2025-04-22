/** @type {import('next').NextConfig} */

const nextConfig = {
  staticPageGenerationTimeout: 30000,
  reactStrictMode: true,
  images: {
    unoptimized: true
  },
  output: 'export',
  distDir: '../dist/controlpanel'
}

module.exports = nextConfig
