import('./main.js').then(module=>module.startDesktop()).catch(()=>{console.error('Desktop startup failed');require('electron').app.exit(1);});
