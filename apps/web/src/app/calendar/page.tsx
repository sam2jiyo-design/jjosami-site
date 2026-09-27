import {PageReady} from '@/components/navigation';
import {Calendar} from '@/components/public/calendar';
import {Heading} from '@/components/ui';
import {readSite} from '@/server/read';
export const metadata={title:'캘린더'};
export default async function Page(){const site=await readSite();return <><PageReady path="/calendar"/><><Heading>캘린더</Heading><Calendar events={site.anniversaries}/></></>}
