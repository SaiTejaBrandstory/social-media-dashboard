import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Use this app folder as root (parent repo also has a package-lock.json)
  outputFileTracingRoot: path.join(__dirname),
  // Prisma must stay external (uses __dirname for engine paths in Node, not Edge)
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
