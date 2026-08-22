#!/usr/bin/env python3
from __future__ import annotations
import base64
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

root = Path(__file__).resolve().parent.parent
specs = [
    ('terser_bounded', 'terser', '5.44.0', 'BSD-2-Clause', 'terser-5.44.0.tgz', 'terser-5.44.0.package-lock.json', 'terser-BSD-2-Clause.txt', 'terser-bounded.worker.js'),
    ('csso_bounded', 'csso', '5.0.5', 'MIT', 'csso-5.0.5.tgz', 'csso-5.0.5.package-lock.json', 'csso-MIT.txt', 'csso-bounded.worker.js'),
    ('html_minifier_terser_bounded', 'html-minifier-terser', '7.2.0', 'MIT', 'html-minifier-terser-7.2.0.tgz', 'html-minifier-terser-7.2.0.package-lock.json', 'html-minifier-terser-MIT.txt', 'html-minifier-terser-bounded.worker.js'),
]
license_ids = {
    'terser': 'BSD-2-Clause', 'csso': 'MIT', 'html-minifier-terser': 'MIT',
    'acorn': 'MIT', 'commander': 'MIT', 'buffer-from': 'MIT', 'source-map-support': 'MIT',
    'source-map': 'BSD-3-Clause', 'css-tree': 'MIT', 'mdn-data': 'CC0-1.0',
    'source-map-js': 'BSD-3-Clause', 'camel-case': 'MIT', 'clean-css': 'MIT',
    'dot-case': 'MIT', 'entities': 'BSD-2-Clause', 'lower-case': 'MIT', 'no-case': 'MIT',
    'param-case': 'MIT', 'pascal-case': 'MIT', 'relateurl': 'MIT', 'tslib': '0BSD',
    '@jridgewell/gen-mapping': 'MIT', '@jridgewell/resolve-uri': 'MIT',
    '@jridgewell/set-array': 'MIT', '@jridgewell/source-map': 'MIT',
    '@jridgewell/sourcemap-codec': 'MIT', '@jridgewell/trace-mapping': 'MIT',
}

def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def tree_sha(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(p for p in path.rglob('*') if p.is_file()):
        digest.update(item.relative_to(path).as_posix().encode())
        digest.update(b'\0')
        digest.update(hashlib.sha256(item.read_bytes()).digest())
    return digest.hexdigest()

def purl(name: str, version: str) -> str:
    return f"pkg:npm/{quote(name, safe='')}@{version}"

components = []
dependencies = []
tool_records = []
for tool_id, package, version, license_id, archive_name, lock_name, license_name, bundle_name in specs:
    archive = root / 'sources/archives' / archive_name
    lock_path = root / 'sources/locks' / lock_name
    license_path = root / 'licenses' / license_name
    bundle_path = root / 'dist' / bundle_name
    lock = json.loads(lock_path.read_text())
    root_ref = f'{tool_id}:root'
    components.append({
        'type': 'library', 'bom-ref': root_ref, 'name': package, 'version': version,
        'purl': purl(package, version), 'licenses': [{'license': {'id': license_id}}],
        'hashes': [{'alg': 'SHA-256', 'content': sha(archive)}],
        'properties': [
            {'name': 'cap:candidateId', 'value': tool_id},
            {'name': 'cap:includedInBundle', 'value': 'true'},
            {'name': 'cap:canonicalNameClaim', 'value': 'false'},
            {'name': 'cap:admitted', 'value': 'false'}
        ]
    })
    child_refs = []
    for package_path, data in sorted(lock['packages'].items()):
        if not package_path.startswith('node_modules/') or data.get('dev', False):
            continue
        name = package_path.rsplit('node_modules/', 1)[-1]
        dep_version = str(data['version'])
        ref = f'{tool_id}:{package_path}'
        child_refs.append(ref)
        integrity = data.get('integrity')
        hashes = []
        if integrity and integrity.startswith('sha512-'):
            hashes.append({'alg': 'SHA-512', 'content': base64.b64decode(integrity.split('-', 1)[1]).hex()})
        included = not (tool_id == 'terser_bounded' and name != 'acorn')
        components.append({
            'type': 'library', 'bom-ref': ref, 'name': name, 'version': dep_version,
            'purl': purl(name, dep_version),
            'licenses': [{'license': {'id': license_ids.get(name, data.get('license', 'MIT'))}}],
            'hashes': hashes,
            'properties': [
                {'name': 'cap:candidateId', 'value': tool_id},
                {'name': 'cap:includedInBundle', 'value': str(included).lower()}
            ]
        })
    dependencies.append({'ref': root_ref, 'dependsOn': child_refs})
    tool_records.append({
        'id': tool_id,
        'engine': {'name': package, 'version': version, 'license': license_id},
        'canonicalNameClaim': False,
        'admitted': False,
        'governance': 'experimental-bounded-worker-lane',
        'limits': {'inputBytes': 1_048_576, 'outputBytes': 1_048_576, 'wallTimeoutMs': 3_000},
        'archive': {'path': f'sources/archives/{archive_name}', 'sha256': sha(archive)},
        'lock': {'path': f'sources/locks/{lock_name}', 'sha256': sha(lock_path), 'entries': len(lock['packages'])},
        'license': {'path': f'licenses/{license_name}', 'sha256': sha(license_path), 'spdx': license_id},
        'bundle': {'path': f'dist/{bundle_name}', 'sha256': sha(bundle_path), 'bytes': bundle_path.stat().st_size},
        'workerOnly': True,
        'mainThreadFallback': False,
        'sourceMap': False,
        'network': False
    })

sbom = {
    'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'serialNumber': 'urn:uuid:3dc6e989-7cc6-5f4c-b9bc-92beb4dc55ee',
    'version': 1,
    'metadata': {
        'component': {'type': 'application', 'bom-ref': 'cap-js-minifiers-bounded', 'name': 'cap-js-minifiers-bounded', 'version': '0.0.0-experimental'},
        'tools': {'components': [
            {'type': 'application', 'name': 'esbuild', 'version': '0.25.12'},
            {'type': 'application', 'name': 'node', 'version': '26.4.0'}
        ]}
    },
    'components': components,
    'dependencies': [{'ref': 'cap-js-minifiers-bounded', 'dependsOn': [f'{s[0]}:root' for s in specs]}, *dependencies]
}
(root / 'sbom/bounded-js-minifiers.cdx.json').write_text(json.dumps(sbom, indent=2, sort_keys=True) + '\n')

inventory = {
    'schemaVersion': 1,
    'name': 'cap-js-minifiers-bounded',
    'status': 'BLOCKED_EXACT_OFFLINE_DEPENDENCY_PROVENANCE',
    'canonicalNameClaim': False,
    'admitted': False,
    'networkDownloads': False,
    'chromeUsed': False,
    'capOrCoDoEdited': False,
    'tools': tool_records,
    'blockers': [
        'The lock-pinned acorn@8.15.0 tarball is absent from the offline npm cache; only an exact-version local package tree was available, so its lock SRI cannot be independently reverified without a prohibited download.'
    ],
    'build': {
        'sourceDateEpoch': 0,
        'esbuild': {'version': '0.25.12', 'treeSha256': tree_sha(root / 'build-tools/node_modules/esbuild')},
        'esbuildPlatform': {'version': '0.25.12', 'treeSha256': tree_sha(root / 'build-tools/node_modules/@esbuild/linux-x64')},
        'acornRuntime': {
            'version': '8.15.0',
            'treeSha256': tree_sha(root / 'vendor-runtime/node_modules/acorn'),
            'lockVersionMatch': True,
            'lockTarballIntegrityVerified': False,
            'provenanceNote': 'Exact-version local package tree; the lock-pinned tarball was absent from the offline npm cache.'
        },
        'twoBuildIdentity': True,
        'terserSourceMapDependencyInMetafile': False,
        'nodeSourceMapSupportIncluded': False
    },
    'evidence': {
        'acceptance': 'evidence/acceptance.json',
        'staticScan': 'evidence/static-scan.json',
        'sbom': 'sbom/bounded-js-minifiers.cdx.json',
        'feasibility': 'evidence/feasibility-v3.md',
        'acceptancePlan': 'evidence/acceptance-plan-v2.md'
    }
}
(root / 'inventory/inventory.json').write_text(json.dumps(inventory, indent=2, sort_keys=True) + '\n')
print(json.dumps({'tools': len(tool_records), 'components': len(components), 'status': inventory['status']}))
