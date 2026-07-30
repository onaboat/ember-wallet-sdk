import { defineConfig } from '@hey-api/openapi-ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  input: resolve(sdkRoot, 'contract/wallet-v1.json'),
  output: process.env.EMBER_WIRE_OUTPUT ?? resolve(sdkRoot, 'src/generated'),
  plugins: [
    {
      name: '@hey-api/typescript',
      topType: 'unknown',
    },
    {
      name: 'zod',
      compatibilityVersion: 4,
      dates: {
        offset: true,
      },
      definitions: true,
      requests: false,
      responses: false,
      $resolvers: {
        number(ctx) {
          if (ctx.schema.format !== 'int64') return undefined;
          if (
            (ctx.schema.minimum !== undefined && ctx.schema.minimum !== 0) ||
            ctx.schema.exclusiveMinimum !== undefined ||
            ctx.schema.maximum !== undefined ||
            ctx.schema.exclusiveMaximum !== undefined
          ) {
            throw new Error(
              'The int64 Zod override only supports an optional zero minimum; update it for this schema.',
            );
          }

          const { z } = ctx.plugin.imports;
          ctx.chain.current = ctx
            .$(z)
            .attr('number')
            .call()
            .attr('int')
            .call()
            .attr('safe')
            .call();
          if (ctx.schema.minimum === 0) {
            ctx.chain.current = ctx.chain.current.attr('nonnegative').call();
          }
          return ctx.chain.current;
        },
      },
    },
  ],
});
