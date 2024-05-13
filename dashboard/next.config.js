/** @type {import('next').NextConfig} */
require('dotenv').config()

const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true
  },
  output: 'export',
  distDir: '../dist/dashboard'
}

module.exports = nextConfig
