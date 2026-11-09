const {join}=require('node:path');
module.exports=async context=>{
 const {flipFuses,FuseVersion,FuseV1Options}=await import('@electron/fuses');
 const binary=context.electronPlatformName==='darwin'?join(context.appOutDir,context.packager.appInfo.productFilename+'.app'):join(context.appOutDir,context.packager.appInfo.productFilename);
 await flipFuses(binary,{version:FuseVersion.V1,resetAdHocDarwinSignature:true,
  [FuseV1Options.RunAsNode]:false,[FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
  [FuseV1Options.EnableNodeCliInspectArguments]:false,[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true,
  [FuseV1Options.OnlyLoadAppFromAsar]:true,[FuseV1Options.EnableCookieEncryption]:true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]:false});
};
