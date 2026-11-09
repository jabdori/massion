const {app}=require('electron');
if(app.commandLine.hasSwitch('massion-headless')){
 const directory=app.commandLine.getSwitchValue('user-data-dir');
 if(!require('node:path').isAbsolute(directory))throw new Error('Headless launch requires an absolute private --user-data-dir');
 app.setPath('userData',directory);app.disableHardwareAcceleration();
 if(process.platform==='darwin')app.setActivationPolicy('accessory');
}
import('./main.js').then(module=>module.startDesktop()).catch(()=>{console.error('Desktop startup failed');require('electron').app.exit(1);});
