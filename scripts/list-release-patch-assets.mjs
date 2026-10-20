import path from 'node:path'
import { args } from './historical-release-lib.mjs'
import { localPublication } from './publish-release-additions.mjs'

// Publish only artifacts named by the validated report. Unrelated or stale ZIPs
// in dist must not bypass the supported-source policy through a wildcard glob.
const options = args()
const directory = path.resolve(options.directory ?? 'dist')
const { names } = await localPublication(options.version, directory)
for (const name of names) console.log(path.join(directory, name))
