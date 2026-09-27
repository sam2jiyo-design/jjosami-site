import {PageReady} from '@/components/navigation';
import {Songbook} from '@/components/public/catalog';
import {Heading} from '@/components/ui';
import {readCategories,readSongs} from '@/server/read';
export const metadata={title:'노래책'};
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){const input=await searchParams,params=new URLSearchParams();Object.entries(input).forEach(([k,v])=>{if(Array.isArray(v))v.forEach(x=>params.append(k,x));else if(v)params.set(k,v)});const [initial,categories]=await Promise.all([readSongs(params),readCategories()]);return <><PageReady path="/songbook"/><><Heading>노래책</Heading><Songbook initial={initial} query={params.toString()} categories={categories}/></></>}
