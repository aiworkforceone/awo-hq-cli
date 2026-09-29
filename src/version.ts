/** The CLI version, stamped by the esbuild bundle (`define`); `0.0.0-dev` when run from source. */
declare const __HQ_VERSION__: string | undefined;

export const HQ_VERSION: string =
  typeof __HQ_VERSION__ === 'string' && __HQ_VERSION__.length > 0 ? __HQ_VERSION__ : '0.0.0-dev';
