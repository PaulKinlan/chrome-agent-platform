// The aggregate gate always drives this checkout, never CAP_ACCEPTANCE_EXT.
import { fileURLToPath } from "node:url";
import { runConstrainedWidthLayout } from "../cap-evidence/constrained-width-layout.ts";

Deno.exit(await runConstrainedWidthLayout(fileURLToPath(new URL("../extension", import.meta.url))));
