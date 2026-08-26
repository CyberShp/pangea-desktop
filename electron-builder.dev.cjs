const packageJson = require('./package.json')

module.exports = {
  ...packageJson.build,
  appId: 'io.pangea.desktop.dev',
  productName: 'PANGEA Desktop Dev',
  directories: {
    ...packageJson.build.directories,
    output: 'dist-dev'
  },
  extraMetadata: {
    name: 'pangea-desktop-dev',
    productName: 'PANGEA Desktop Dev',
    dshDesktopChannel: 'development'
  },
  artifactName: 'pangea-desktop-dev-${os}-${arch}.${ext}',
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'pangea-desktop-dev-windows-${arch}-setup.${ext}'
  },
  publish: null
}
