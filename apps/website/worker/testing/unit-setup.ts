// Runs before each unit test file: hands it the databases the run's global
// setup built (worker/testing/provided.ts).

import { inject } from "vite-plus/test";
import { PROVIDED_DATABASES, provideDatabases, type ProvidedDatabases } from "./provided.ts";

provideDatabases((inject as (key: string) => ProvidedDatabases | undefined)(PROVIDED_DATABASES));
