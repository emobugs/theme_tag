import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  poweredByHeader: false,
  // проектът е самостоятелен, дори да стои в папка на друго репо
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
