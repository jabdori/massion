const {app}=require('electron');
if(process.platform!=='linux'||!process.env.DISPLAY)throw new Error('Linux Xvfb required; native visible launches are forbidden');
app.disableHardwareAcceleration();
app.setPath('userData',process.env.MASSION_E2E_DESKTOP_DATA);
process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='quit')app.quit();});
import('../../desktop/dist/main.js').then(({startDesktop})=>startDesktop()).catch(error=>{console.error(error);app.exit(1);});
