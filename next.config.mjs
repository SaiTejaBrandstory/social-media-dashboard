/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Prisma must stay external (uses __dirname for engine paths in Node, not Edge)
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
