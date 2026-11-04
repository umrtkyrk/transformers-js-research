# İngiltere emlak araması için kurmaca doğrulama verileri

Bu klasör, Transformers.js ile yapılacak küçük bir teknik denemenin tekrar üretilebilir girdilerini içerir. 60 ilan ve 80 sorgu elle hazırlanmıştır. İlanların hiçbiri gerçek bir emlak kaydı, müşteri, adres veya piyasa gözlemi değildir. Fiyatlar, uygunluk durumları ve emlak özellikleri tamamen kurmacadır. Bu veri kümesi gerçek İngiltere piyasasını veya gerçek kullanıcı dağılımını temsil etmez.

Araştırmanın M1 adayı olan `Xenova/paraphrase-multilingual-MiniLM-L12-v2` ile metin temsili üretimini değerlendirmek için hazırlanmıştır. Bu klasörün hazırlanması sırasında model çalıştırılmamış, embedding üretilmemiş ve benzerlik skorları kullanılmamıştır. Model başarısı hakkında sonuç içermez.

## Dosyalar

- `listings.json`: 12 şehirde beşer tane olmak üzere 60 kurmaca ilan.
- `queries.json`: 20 `development` ve 60 `evaluation` sorgusu. Doğru kabul edilen ilan kimlikleri insan tarafından yazılmıştır.
- `structured-filter-gold.json`: Her sorgu için yalnızca yapılandırılmış koşulları sağlayan ilanların elle kaydedilmiş ayrı listesi.
- `validate_dataset.py`: Alanları, kayıt sayılarını, filtre beklentilerini ve doğru cevap referanslarını kontrol eder. Model kalitesini ölçmez.
- `data-validation-report.json`: Kontrol betiğinin ürettiği veri tutarlılığı kaydı. Bir inference veya performans raporu değildir.
- `prepare_crm_dataset.py`: Verilerin elle yazılmış kaynak tanımı. Tekrar çalıştırılırsa yukarıdaki üç veri dosyasını aynı içerikle oluşturur.

Sürüm: `1.0.0`. Hazırlanma tarihi: 26 Ekim 2026. Veri ve kod İngilizce, bu açıklama Türkçedir.

## İlan kapsamı ve alanlar

Şehirler Manchester, Bristol, Leeds, London, Birmingham, Nottingham, Newcastle, Liverpool, Brighton, Sheffield, Cambridge ve Oxford'dur. `alpha` ve `beta` adlı iki kurmaca ofis bulunur. Her şehirde başka ofise ait benzer bir ilan ve artık uygun olmayan bir ilan vardır. Bu kayıtlar, yetki ve aktiflik koşullarının benzerlik skoruna bırakılmamasını kontrol etmek içindir.

Bir ilan şu alanlara sahiptir:

```json
{
  "id": "UK001",
  "office": "alpha",
  "city": "Manchester",
  "tenure": "rent",
  "price_gbp": 1200,
  "bedrooms": 2,
  "active": true,
  "text": "A bright two-bedroom flat in Manchester..."
}
```

`tenure`, bu veri sözleşmesinde yalnızca `rent` veya `sale` işlem türünü belirtir. İngiltere'deki freehold veya leasehold mülkiyet süresini tanımlamaz. `rent` fiyatı aylık kira, `sale` fiyatı toplam istenen satış bedelidir. Bu iki tutar aynı fiyat filtresinde işlem türü belirtilmeden anlamlı biçimde karşılaştırılmamalıdır. `bedrooms=0`, ayrı yatak odası olmayan stüdyo içindir.

İlan türleri flat, detached house, semi-detached house, terraced house ve cottage içerir. Özel bahçe, bahçe yokluğu, balkon, ortak avlu, garaj, garaj yokluğu, araç park yeri, asansör, basamaksız giriş, evcil hayvan kabulü ve çalışma alanı gibi özellikler metne yazılmıştır. Açıkça belirtilmeyen bir özelliğin varlığı veya yokluğu varsayılmaz.

## Üç farklı beklenti birbirinden ayrılır

### Yapılandırılmış koşullar

`allowed_office`, `active`, `city`, `tenure`, `max_price_gbp` ve `min_bedrooms` uygulamanın deterministik filtreleridir. Bunlar embedding skoruyla uygulanmaz. Bütün sorgularda `active=true` bulunur. `max_price_gbp` kapsayıcı üst sınır, `min_bedrooms` kapsayıcı alt sınırdır.

`structured-filter-gold.json` yalnızca bu filtrelerden sonra kalması gereken adayları listeler. Bu dosya, `relevant_ids` ile aynı şey değildir. Örneğin Q005 için UK021 ve UK025 yapılandırılmış koşulları sağlar; yalnızca UK021 istenen yarı müstakil ev ve özel bahçe özelliklerini taşır.

### Anlama göre ilgili kayıtlar

`queries.json` içindeki `relevant_ids`, hem yapılandırılmış koşulları hem de sorguda açıkça istenen metinsel özellikleri sağlayan kayıtları gösterir. Etiketler modelin skorundan türetilmemiştir. Flat ve apartment eş anlamlı kabul edilir. Detached house ve semi-detached house aynı tür kabul edilmez. Balkon veya ortak avlu, özel bahçenin yerine geçmez. Bir sorgu açıkça iki yatak odası istiyorsa `min_bedrooms=2` filtresinin bıraktığı üç yatak odalı bir kayıt, anlam etiketinde otomatik olarak doğru sayılmaz.

Eksik bilgi sorgularında şehir, bütçe veya işlem türü uydurulmaz. Belirtilen özelliklere uyan birden fazla kayıt varsa tamamı etiketlenir. Bu sorgular, uygulamanın kullanıcıya mutlaka soru sorması gerektiğini veya açıklama isteme diyaloğunun test edildiğini göstermez. Buradaki etiketler yalnızca verilen kısıtlarla ilgili sonuç kümesini tanımlar.

### Cevapsız durumlar

80 sorgunun 12'sinde `expected_no_result=true` ve `relevant_ids=[]` bulunur:

- 5 sorguda yapılandırılmış filtrelerden sonra aday kalmaz. Bunlar `no_result` kategorisindedir.
- 2 sorguda aday vardır ancak istenen anlam veya olumsuz koşul karşılanmaz. Bunlar Q019 ve Q050 `negative_challenge` örnekleridir.
- 5 sorgu anlamlı bir emlak ihtiyacı ifade etmez. Bunlar `nonsense` kategorisindedir.

Bir modelin her sorguya sayısal temsil üretebilmesi, uygun bir ilan bulunduğunu göstermez. Cevapsız kararı için kullanılacak yöntem veya eşik ayrı tasarlanmalıdır. Bu veri dosyalarında hazır skor eşiği yoktur.

## Sorgu grupları

`paraphrase`, `location`, `negative_challenge`, `preference`, `missing_information`, `nonsense` ve `no_result` kategorileri bulunur. `negative_challenge`, özellikle bahçe veya garaj yokluğu gibi açık olumsuz koşulları ve yakın fakat yanlış alternatifleri kapsar. Bu koşulların sayısal temsil benzerliği tarafından kesin olarak uygulanabildiği varsayılmaz.

Development grubunda 20 sorgu ve üç cevapsız örnek; evaluation grubunda 60 sorgu ve dokuz cevapsız örnek vardır. Çoklu doğru cevap içeren 11 sorgu bulunur. Kategoriler dengeli bir kullanıcı dağılımını temsil etmek amacıyla seçilmemiştir.

## Denemede kullanım

Önce `development` sorguları ile çalışmanın açıldığını, kayıt kimliklerinin korunduğunu, filtrelerin uygulandığını ve ölçümlerin kaydedildiğini kontrol edin. Eşik veya başka ayarlar gerekiyorsa yalnızca bu bölümde seçin. `evaluation` cevapları kullanılarak ayar yapıldıktan sonra aynı grup bağımsız değerlendirme olarak sunulmamalıdır.

Her sorguda önce ofis yetkisi ve yapılandırılmış koşullar uygulanmalıdır. Ardından kalan kayıtların anlam sıralaması, `relevant_ids` ile karşılaştırılabilir. Ayrı kaydedilecek ölçümler arasında yapılandırılmış filtre doğruluğu, ilk k sonuçta ilgili kayıt bulunması, çoklu doğru cevapların kapsanması ve cevapsız durum davranışı vardır. Sadece ilk k içinde bir doğru sonuç bulunması, bütün şartları sağlayan kayıtların eksiksiz listelendiğini göstermez.

İlan açıklamaları ve sorgular İngilizcedir. Çokdilli model kullanılması bu veriyle Türkçe başarısının veya diğer dillerin sınandığı anlamına gelmez. Aynı ilan havuzu iki sorgu bölümünde de kullanılır; farklı müşteri veya yeni ilan dağılımına genelleme ölçülmez. Metinler kasıtlı olarak düzenli ve kısa tutulmuştur; gerçek CRM'deki eksik alanlar, bozuk veri, veri güncellemesi, fotoğraflar, kullanıcı izinleri ve uzun açıklamaların tüm çeşitliliği bu veriyle kapsanmaz.

Doğru cevaplar tek bir hazırlayıcının elle verdiği etiketlerdir. Bağımsız ikinci insan etiketlemesi veya etiketleyiciler arası uyum ölçümü yapılmamıştır. Gerçek ürün değerlendirmesi öncesinde alan uzmanı incelemesi ve daha temsilî veri gerekir. Ölçülen bir sonuç yalnızca bu veri kümesi, model sürümü ve çalışma koşulları için raporlanmalıdır.

## Tutarlılık kontrolü

Python 3 ile şu komut çalıştırılabilir:

```text
python validation/data/validate_dataset.py
```

Kontrol, 60 ilanı, 80 sorguyu, 20/60 bölüm ayrımını, 12 cevapsız örneği, bütün doğru cevapların varlığını, her doğru cevabın yapılandırılmış koşulları sağlamasını ve elle hazırlanmış filtre listelerinin bağımsız filtre hesabıyla eşleşmesini doğrular. Metinsel anlam etiketlerinin doğruluğunu otomatik olarak kanıtlamaz.

Gelecekte veri değişirse ilgili `relevant_ids` ve `structured-filter-gold.json` kayıtları birlikte yeniden incelenmelidir. Sonuçları iyileştirmek için yalnızca zor örnekleri çıkarmak veya evaluation etiketlerine göre sorguları değiştirmek, aynı değerlendirme grubunun bağımsızlığını bozar.
