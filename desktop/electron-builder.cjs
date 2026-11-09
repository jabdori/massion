const {build}=require('./package.json'),{version}=require('../package.json');
const bundleVersion=version.split('-')[0];
module.exports={...build,extraMetadata:{version},mac:{...build.mac,bundleVersion,bundleShortVersion:bundleVersion}};
