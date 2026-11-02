/**
 * Write a courier's own city ids, from the list they sent us, onto the fee rows.
 *
 *   npx tsx scripts/import-courier-cities.ts BASHA --dry
 *   npx tsx scripts/import-courier-cities.ts BASHA
 *
 * NOT NEEDED FOR A SHIPMENT TO GO any more (2/11): the press takes a governorate's city from the courier's own list by
 * itself when nothing is typed (`src/lib/couriers/city-id.ts`). This is for the day somebody wants the numbers stored
 * on the rows anyway — a number stored here is read as typed, and wins over the list from then on.
 *
 * Their list is per VILLAGE; a shipment is addressed per CITY, and our orders carry a محافظة. The city of each of our
 * governorates is chosen by THE rule of `src/lib/couriers/places.ts` (`defaultCourierCityId`): the same one the press,
 * the warning before it, the Excel file and the box on the fees screen use — this script has no rule of its own.
 *
 * It prints what it will change before changing anything, and it never invents a match: a governorate their list does
 * not answer is reported, not guessed at. Guessing there would address a parcel to the wrong governorate. A number
 * already stored that differs from the list's is replaced and printed as «كان …», so run it with --dry first.
 */
import { db } from '../src/lib/db';
import { courierPlaces, defaultCourierCityId } from '../src/lib/couriers/places';

async function main() {
  const code = (process.argv[2] || '').toUpperCase();
  const dry = process.argv.includes('--dry');
  if (!code) {
    console.error('الاستعمال: npx tsx scripts/import-courier-cities.ts <رمز الشركة> [--dry]');
    process.exit(1);
  }

  const places = courierPlaces(code);
  if (!places) {
    console.error(`ما عندنا قائمة مدن لشركة برمز ${code}`);
    process.exit(1);
  }

  const provider = await db.deliveryProvider.findFirst({
    where: { code },
    select: { id: true, name: true },
  });
  if (!provider) {
    console.error(`لا شركة شحن برمز ${code}`);
    process.exit(1);
  }

  const fees = await db.deliveryFee.findMany({
    where: { deliveryProviderId: provider.id },
    select: { id: true, courierCityId: true, region: { select: { name: true } } },
    orderBy: { region: { name: 'asc' } },
  });

  const updates: { id: string; cityId: number; region: string; city: string; was: number | null }[] = [];
  const unmatched: string[] = [];

  for (const fee of fees) {
    const city = defaultCourierCityId(code, fee.region.name);
    if (!city) {
      unmatched.push(fee.region.name);
      continue;
    }
    if (fee.courierCityId === city.cityId) continue;
    updates.push({ id: fee.id, cityId: city.cityId, region: fee.region.name, city: city.cityName, was: fee.courierCityId });
  }

  console.log(`${provider.name} — ${Object.keys(places.cities).length} مدينة في ${Object.keys(places.regions).length} محافظة عندهم\n`);
  for (const u of updates) {
    console.log(`  ${u.region.padEnd(12)} → ${String(u.cityId).padEnd(8)} ${u.city}${u.was ? `  (كان ${u.was})` : ''}`);
  }
  if (unmatched.length) {
    console.log(`\n  ⚠️  لا يخدمون هذه المحافظات: ${unmatched.join('، ')}`);
    console.log('     الشحنات إليها لا يمكن إنشاؤها عندهم — حوّلها لشركة أخرى أو اسألهم.');
  }

  if (dry) {
    console.log('\n(تجربة — لم يُكتب شيء)');
  } else {
    for (const u of updates) {
      await db.deliveryFee.update({ where: { id: u.id }, data: { courierCityId: u.cityId } });
    }
    console.log(`\nحُدِّث ${updates.length} صفّاً.`);
  }

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
