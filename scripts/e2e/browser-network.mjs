import {createBrowserDenyProxy} from '../../src/browser-network.ts';
export async function createBrowserNetwork(){const proxy=await createBrowserDenyProxy();return {config:{proxy:proxy.url,proxyBypass:'<-loopback>;127.0.0.1',args:'--force-webrtc-ip-handling-policy=disable_non_proxied_udp'},close:proxy.close};}
