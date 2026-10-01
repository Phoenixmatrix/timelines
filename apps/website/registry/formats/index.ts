import type { FormatId } from "@gitmatrix/formats/info";

import { aptFormat } from "./apt/index.ts";
import { brewFormat } from "./brew/index.ts";
import { cargoFormat } from "./cargo/index.ts";
import { genericFormat } from "./generic/index.ts";
import { goFormat } from "./go/index.ts";
import { helmFormat } from "./helm/index.ts";
import { mavenFormat } from "./maven/index.ts";
import { npmFormat } from "./npm/index.ts";
import { ociFormat } from "./oci/index.ts";
import { pypiFormat } from "./pypi/index.ts";
import { releasesFormat } from "./releases/index.ts";
import { rpmFormat } from "./rpm/index.ts";
import type { FormatModule } from "./types.ts";

const MODULES: Record<FormatId, FormatModule> = {
  npm: npmFormat,
  oci: ociFormat,
  pypi: pypiFormat,
  maven: mavenFormat,
  cargo: cargoFormat,
  go: goFormat,
  helm: helmFormat,
  apt: aptFormat,
  rpm: rpmFormat,
  brew: brewFormat,
  generic: genericFormat,
  releases: releasesFormat,
};

export function registeredFormats(): FormatModule[] {
  return Object.values(MODULES);
}

export function formatModule(id: FormatId): FormatModule {
  return MODULES[id];
}
