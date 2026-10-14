// Shared facts about the public site (CORE-115).

/** Defined at build by astro.config.ts, from GITMATRIX_PRODUCTION_HOST (src/hosts.ts). */
declare const __TIMELINES_APP_URL__: string;

/** The Timelines web app, where people sign in. */
export const APP_URL: string = __TIMELINES_APP_URL__;
