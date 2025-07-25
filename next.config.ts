import type { NextConfig } from "next";
import type { Configuration } from "webpack";
import path from "path";

const nextConfig: NextConfig = {
  webpack: (config: Configuration) => {
    // Return a new config object with our changes
    return {
      ...config, // Copy all existing properties
      watchOptions: {
        ...config.watchOptions, // Copy existing watchOptions
        ignored: [
          // Copy existing ignored paths (if any)
          ...(Array.isArray(config.watchOptions?.ignored) ? config.watchOptions.ignored : []),
          // Add our new path to ignore
          path.resolve(__dirname, 'live'),
        ],
      },
    };
  },
};

export default nextConfig;