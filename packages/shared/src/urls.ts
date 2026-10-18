/**
 * The only addresses Ystara sends anything to: a Datasphere tenant (the worker
 * sends it a bearer token, and the Technical client page shows what came back) and SAP's
 * sign-in service for the tenant's technical client (the worker sends it the
 * client's secret). A typo or a hostile URL must point neither at another
 * server: an IP address, a host inside the company network, or an app on SAP's
 * cloud platform (*.cfapps.….hana.ondemand.com).
 *
 * The API checks both when they are entered, and the worker again before each
 * login, for rows saved before these rules. Plain functions without Node, so
 * the web app can use them too.
 */
const TENANT_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.hcs\.cloud\.sap$/;
const TOKEN_HOST = /^[a-z0-9-]+\.authentication\.[a-z0-9-]+\.hana\.ondemand\.com$/;

export const DATASPHERE_URL_HINT = "Use the tenant's address: https://<tenant>.<region>.hcs.cloud.sap";
export const TOKEN_URL_HINT = "Use the token URL from the App Integration page: https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token";

/** https://<tenant>.<region>.hcs.cloud.sap, nothing after it but an optional "/". */
export function isDatasphereUrl(value: string): boolean {
  const url = plainHttps(value);
  return url !== undefined && TENANT_HOST.test(url.hostname) && url.pathname === "/";
}

/** https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token, as App Integration shows it. */
export function isTokenUrl(value: string): boolean {
  const url = plainHttps(value);
  return url !== undefined && TOKEN_HOST.test(url.hostname) && url.pathname.replace(/\/$/, "") === "/oauth/token";
}

/** The URL when it is https on the default port, without a user name, password, query or fragment. */
function plainHttps(value: string): URL | undefined {
  if (!URL.canParse(value) || /[?#]/.test(value)) return undefined;
  const url = new URL(value); // the host comes back lowercased, and ":443" as no port
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password ? url : undefined;
}
