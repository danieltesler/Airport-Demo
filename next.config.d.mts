declare const nextConfig: {
  reactStrictMode: boolean;
  headers(): Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
};
export default nextConfig;
