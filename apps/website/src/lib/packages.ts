import { FORMATS, type FormatId } from "@gitmatrix/formats/info";
import { packagePath, packagesPath, type PackageSummary } from "../../shared/packages.ts";

export { FORMATS, packagePath, packagesPath };

export function feedsPath(owner: string): string {
  return `/${owner}/-/feeds`;
}

/** …and travel as one encoded segment in the API's. */
export function packageApi(owner: string, format: FormatId, name: string): string {
  return `/packages/${owner}/${format}/${encodeURIComponent(name)}`;
}

export function formatLabel(format: FormatId): string {
  return FORMATS[format]?.label ?? format;
}

/** The one command that gets this package onto a machine. */
export function installCommand(
  registryUrl: string,
  pkg: Pick<PackageSummary, "format" | "name" | "feed" | "latest">,
): string {
  const base = registryUrl.replace(/\/+$/, "");
  const host = new URL(base).host;
  const at = pkg.latest ?? "latest";
  const feed = pkg.feed;
  switch (pkg.format) {
    case "npm":
      return `npm install ${pkg.name}@${at} --registry=${base}/npm/${feed}/`;
    case "oci":
      return `docker pull ${host}/${feed}/${pkg.name}:${at}`;
    case "pypi":
      return `pip install ${pkg.name}==${at} --index-url ${base}/pypi/${feed}/simple/`;
    case "cargo":
      return `cargo add ${pkg.name}@${at} --index sparse+${base}/cargo/${feed}/index/`;
    case "go":
      return `GOPROXY=${base}/go/${feed} go get ${pkg.name}@${at}`;
    case "helm":
      return `helm repo add ${feed} ${base}/helm/${feed} && helm install ${pkg.name} ${feed}/${pkg.name} --version ${at}`;
    case "maven":
      return `mvn dependency:get -DremoteRepositories=${base}/maven/${feed}/ -Dartifact=${pkg.name}:${at}`;
    case "generic":
      return `curl -fLO -H "Authorization: Bearer $GITMATRIX_TOKEN" ${base}/generic/${feed}/${pkg.name}/${at}/<file>`;
    case "releases":
      return `curl -fL ${base}/releases/${feed}/${pkg.name}/${at}`;
    case "apt":
      return `echo "deb ${base}/apt/${feed} stable main" | sudo tee /etc/apt/sources.list.d/${feed}.list && sudo apt install ${pkg.name}`;
    case "rpm":
      return `sudo dnf config-manager --add-repo ${base}/rpm/${feed}/${feed}.repo && sudo dnf install ${pkg.name}`;
    case "brew":
      return `brew tap ${feed}/tap ${base}/brew/${feed} && brew install ${pkg.name}`;
  }
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en");

export function count(n: number): string {
  return n >= 10_000 ? compact.format(n) : whole.format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}
