import {PageReady} from '@/components/navigation';
import {readSite} from '@/server/read';
import {liveStatus} from '@/server/providers';
import {Home} from '@/components/public/home';
export default async function Page(){const [site,live]=await Promise.all([readSite(),liveStatus()]);return <><PageReady path="/"/><Home site={site} initialLive={live}/></>}
