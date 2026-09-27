import {PageReady} from '@/components/navigation';
import {headers} from 'next/headers';
import {RequestForm} from '@/components/public/requests';
export const metadata={title:'방셀 신청',robots:{index:false,follow:false}};
export default async function Page(){return <><PageReady path="/requests"/><RequestForm siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY||''} nonce={(await headers()).get('x-nonce')||undefined}/></>}
