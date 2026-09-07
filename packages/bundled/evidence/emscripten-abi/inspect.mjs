// Compile-only evidence inventory. This never instantiates Wasm or imports glue.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const valueTypes = new Map([
  [0x7f, "i32"],
  [0x7e, "i64"],
  [0x7d, "f32"],
  [0x7c, "f64"],
  [0x7b, "v128"],
  [0x70, "funcref"],
  [0x6f, "externref"],
]);
const kindNames = ["function", "table", "memory", "global", "tag"];

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }
  byte() {
    if (this.offset >= this.bytes.length) throw new Error("truncated Wasm");
    return this.bytes[this.offset++];
  }
  u32() {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    throw new Error("invalid u32 LEB");
  }
  take(length) {
    if (this.offset + length > this.bytes.length) {
      throw new Error("truncated Wasm field");
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  name() {
    return textDecoder.decode(this.take(this.u32()));
  }
  valueType() {
    const byte = this.byte();
    return valueTypes.get(byte) ?? `0x${byte.toString(16)}`;
  }
  limits(kind = "memory") {
    const flags = this.u32();
    if (flags & 4) throw new Error(`${kind}64 is outside this A0 decoder`);
    const limits = { min: this.u32(), max: flags & 1 ? this.u32() : null };
    return kind === "memory"
      ? { ...limits, shared: Boolean(flags & 2), memory64: false }
      : limits;
  }
  vector(readEntry) {
    return Array.from({ length: this.u32() }, () => readEntry());
  }
}

function parseWasm(bytes) {
  const validated = new WebAssembly.Module(bytes);
  const reader = new Reader(bytes);
  if (Buffer.from(reader.take(8)).toString("hex") !== "0061736d01000000") {
    throw new Error("bad Wasm header");
  }
  const sections = [];
  while (reader.offset < bytes.length) {
    const id = reader.byte();
    sections.push({ id, bytes: reader.take(reader.u32()) });
  }

  const types = [];
  for (const { id, bytes: payload } of sections) {
    if (id !== 1) continue;
    const r = new Reader(payload);
    types.push(...r.vector(() => {
      if (r.byte() !== 0x60) throw new Error("unsupported non-function type");
      return {
        params: r.vector(() => r.valueType()),
        results: r.vector(() => r.valueType()),
      };
    }));
  }

  const imports = [];
  const memories = [];
  const tables = [];
  const globals = [];
  const tags = [];
  const customSections = [];
  for (const { id, bytes: payload } of sections) {
    const r = new Reader(payload);
    if (id === 0) {
      const name = r.name();
      const custom = { name, bytes: r.bytes.length - r.offset };
      if (name === "dylink.0") {
        custom.subsections = [];
        while (r.offset < r.bytes.length) {
          const type = r.byte();
          const sub = new Reader(r.take(r.u32()));
          const detail = { type, bytes: sub.bytes.length };
          if (type === 1) {
            detail.memoryInfo = {
              memorySize: sub.u32(),
              memoryAlignment: sub.u32(),
              tableSize: sub.u32(),
              tableAlignment: sub.u32(),
            };
          } else if (type === 2) {
            detail.needed = sub.vector(() => sub.name());
          }
          custom.subsections.push(detail);
        }
      }
      customSections.push(custom);
    } else if (id === 2) {
      imports.push(...r.vector(() => {
        const module = r.name();
        const symbol = r.name();
        const kindCode = r.byte();
        const kind = kindNames[kindCode] ?? `unknown-${kindCode}`;
        let type;
        if (kindCode === 0) {
          const typeIndex = r.u32();
          type = { typeIndex, ...types[typeIndex] };
        } else if (kindCode === 1) {
          type = { element: r.valueType(), ...r.limits("table") };
          tables.push({ imported: true, module, symbol, ...type });
        } else if (kindCode === 2) {
          type = r.limits();
          memories.push({ imported: true, module, symbol, ...type });
        } else if (kindCode === 3) {
          type = { value: r.valueType(), mutable: Boolean(r.byte()) };
          globals.push({ imported: true, module, symbol, ...type });
        } else if (kindCode === 4) {
          const attribute = r.byte();
          const typeIndex = r.u32();
          type = { attribute, typeIndex, ...types[typeIndex] };
          tags.push({ imported: true, module, symbol, ...type });
        } else throw new Error(`unknown import kind ${kindCode}`);
        return { module, symbol, kind, type };
      }));
    } else if (id === 4) {
      tables.push(
        ...r.vector(() => ({
          imported: false,
          element: r.valueType(),
          ...r.limits("table"),
        })),
      );
    } else if (id === 5) {
      memories.push(...r.vector(() => ({ imported: false, ...r.limits() })));
    } else if (id === 6) {
      // Initializer expressions are deliberately not interpreted; the count and
      // exported kinds below are sufficient for this compiler-profile record.
      globals.push(
        ...Array.from({ length: r.u32() }, () => ({ imported: false })),
      );
    } else if (id === 13) {
      tags.push(...r.vector(() => {
        const attribute = r.byte();
        const typeIndex = r.u32();
        return { imported: false, attribute, typeIndex, ...types[typeIndex] };
      }));
    }
  }

  return {
    imports,
    exports: WebAssembly.Module.exports(validated),
    features: { memories, tables, globalCount: globals.length, tags },
    customSections,
  };
}

const builds = ["build-a", "build-b"];
const byBuild = {};
for (const build of builds) {
  const files = (await readdir(new URL(`./${build}/`, import.meta.url))).sort();
  byBuild[build] = [];
  for (const file of files) {
    const bytes = await readFile(
      new URL(`./${build}/${file}`, import.meta.url),
    );
    const record = {
      file,
      bytes: bytes.length,
      sha256: sha256(bytes),
      kind: file.endsWith(".wasm") ? "wasm" : "javascript",
    };
    if (file.endsWith(".wasm")) record.wasm = parseWasm(bytes);
    else {
      const source = bytes.toString("utf8");
      record.javascript = {
        evalCalls: source.match(/\beval\s*\(/g)?.length ?? 0,
        functionConstructors: source.match(/\bnew\s+Function\s*\(/g)?.length ??
          0,
        globalThisReferences: source.match(/\bglobalThis\b/g)?.length ?? 0,
      };
    }
    byBuild[build].push(record);
  }
}

const hashes = Object.fromEntries(
  byBuild["build-b"].map((entry) => [entry.file, entry.sha256]),
);
const mismatches = byBuild["build-a"]
  .filter((entry) => hashes[entry.file] !== entry.sha256)
  .map((entry) => entry.file);
const report = {
  format: "cap-emscripten-abi-evidence-v1",
  method:
    "WebAssembly.Module compile-only plus typed section decode; JavaScript token count; no glue import or Wasm instantiation",
  compilerProfile: {
    emscripten: "6.0.0",
    modularize: true,
    exportEs6: true,
    environment: "worker",
    dynamicExecution: false,
    filesystem: false,
    initialMemoryBytes: 16777216,
    memoryGrowth: false,
  },
  reproducibility: {
    compared: builds,
    byteIdentical: mismatches.length === 0,
    mismatches,
  },
  builds: byBuild,
};
await writeFile(
  new URL("./artifact-report.json", import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `inspected ${
    byBuild["build-a"].length + byBuild["build-b"].length
  } assets; byte-identical=${report.reproducibility.byteIdentical}`,
);
