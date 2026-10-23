const { build } = require('./package.json')

module.exports = {
  ...build,
  appId: 'io.pangea.desktop.acceptance',
  productName: 'PANGEA Desktop Acceptance',
  directories: { ...build.directories, output: 'dist-macos' },
  extraMetadata: { dshDesktopChannel: 'acceptance' },
  extraResources: build.extraResources.filter(resource =>
    !['node_modules/node/bin/node.exe', 'build/apply-portable-update.ps1'].includes(resource.from)
  ).concat([{ from: 'node_modules/node/bin/node', to: 'app/node_modules/node/bin/node' }]),
  artifactName: 'pangea-desktop-${version}-macos-${arch}-acceptance.${ext}',
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    icon: 'build/icon.icns',
    category: 'public.app-category.developer-tools',
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    minimumSystemVersion: '12.0'
  },
  publish: null
}
