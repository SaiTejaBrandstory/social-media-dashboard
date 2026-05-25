import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Parent folder has another package-lock.json — pin tracing to this app only
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
