# Otomatik model deneyleri

Yayımlanan kayıtlar: [Otomatik deneyler](https://transformers-js-research.vercel.app/lab/).

**Etkin çalışma ortamı GitHub Actions’tır.** Sitedeki “Yeni sürümü kontrol et” düğmesi, yeni ve desteklenen kararlı sürüm varsa bulut işini başlatır. Aynı sürümün tamamlanmış sonucu yeniden kullanılır. Yerel Windows günlük görevi devre dışıdır. Bulut kurulumu, yetkiler ve kalıcı kayıt yapısı `cloud/README.md` içindedir. Aşağıdaki komutlar yerel deneyler için kullanılabilir.

Bu program seçili model depolarını ve kararlı Transformers.js sürümlerini izler, mevcut beş görev protokolünü ayrı süreçlerde çalıştırır, HTML/JSON raporlarını üretir ve Vercel'e yayımlar. ChatGPT, OpenAI veya başka bir ücretli LLM API entegrasyonu yoktur. Yerel üretim modelleri normal olarak token üretir; bunun bedeli bir LLM API faturası değildir, yerel işlem ve bellek kullanımıdır.

## Hazır kurulumda kullanım

Komutları proje ana klasöründe çalıştırın:

```powershell
node lab/cli.mjs status
node lab/cli.mjs check
node lab/cli.mjs watch
node lab/cli.mjs run --version 4.3.2
node lab/cli.mjs model --id Xenova/all-MiniLM-L6-v2 --version 4.3.2
node lab/cli.mjs retry --run RUN_ID
node lab/cli.mjs build
node lab/cli.mjs publish
```

`check` yalnız metadata sorgular ve sıraya alır. `watch` metadata sorgular, en fazla bir sıradaki işi çalıştırır, raporları üretir ve yayınlar. `run` sabit beşliyi verilen tam sürümle dener. `model` uyumlu adayı görev yuvasına koyar; diğer dört model sabit kalır. Biten aynı kombinasyon tekrar çalıştırılmaz; `--force` açıkça tekrar ister. `retry` eksik kaydı silmeden yeni koşu oluşturur. Bütün komutlar eşzamanlı çalışmayı engelleyen kilit kullanır; `status` salt okunur.

## Günlük çalışma

Önceki Windows günlük görevi GitHub Actions’a geçişte devre dışı bırakılmıştır. Yerel günlük çalışma yeniden tercih edilirse `run-monitor.ps1` ve aşağıdaki kurulum komutları kullanılabilir. Bu durumda bilgisayarın açık, kullanıcının oturumu açık ve ağ erişiminin olması gerekir. Codex veya ChatGPT'nin açık olması gerekmez; zamanlayıcı bir AI ajanını uyandırmaz.

Kurulumu yenilemek için:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File lab/install-schedule.ps1 -NodePath "C:/Program Files/nodejs/node.exe"
Get-ScheduledTask -TaskName "TransformersJS Research Monitor"
Start-ScheduledTask -TaskName "TransformersJS Research Monitor"
Disable-ScheduledTask -TaskName "TransformersJS Research Monitor"
Enable-ScheduledTask -TaskName "TransformersJS Research Monitor"
```

Saat `config.json` içindedir. Değiştirince kurulum betiğini yeniden çalıştırın. Parola kaydedilmez; görev mevcut kullanıcının açık oturumunda çalışır. Görevi kaldırmak için `Unregister-ScheduledTask -TaskName "TransformersJS Research Monitor" -Confirm:$false` kullanın. Deney kayıtları kaldırılmaz.

## Takip ve görevler

- Sabit başlangıç beşlisi: MiniLM anlamsal arama, DistilBERT ikili duygu, Whisper ses dökümü, SpeechT5 + HiFiGAN konuşma üretimi, Qwen metin üretimi.
- İzlenen modelin yeni commit'i varsa gerekli dosyalar ve adapter uyumu kontrol edilir. Model commit'i koşu başında sabitlenir.
- Xenova ve onnx-community hesaplarının en yeni 40 Transformers.js etiketli deposu günlük kontrol edilir. İlk tarama mevcut depoları başlangıç listesine alır; bu ilk listedeki bütün modeller topluca indirilmez. Sonraki yeni ve uyumlu adaylar sıraya alınır. Günlük 40'tan fazla yeni depo oluşursa bu sınırlı tarama hepsini yakalamayabilir.
- Yeni model mimarisi, etiket şeması, ek ONNX veri düzeni veya uzun bağlam yeni adapter gerektirebilir. Şu anda embedding için BERT ve en fazla 512 bağlam, duygu için BERT/DistilBERT/RoBERTa ikili POSITIVE/NEGATIVE, ASR için Whisper, TTS için SpeechT5, üretim için Qwen2 ailesi tanımlıdır. Bu sınırlar tüm Hub modellerini destekleme iddiası değildir.
- Yeni ana kütüphane sürümü (örneğin 5.x), protokol uyumu gözden geçirilene kadar otomatik çalıştırılmaz. 4.x tam ve kararlı sürümler izlenir; beta/dev etiketleri seçilmez.

## Test ve sonuçlar

Her iş yeni klasörde aynı 11 aşamayı çalıştırır: ortam, 80 filtre örneği, M1/M2 Node ve toplu işlem/ölçek, vektör tanısı, M3'ün 23 sesi, M4'ün 8 sesi, M5'in 24 istemi, ses geri dökümü, kurulum örneği, iki modelde Edge WASM ve backend karşılaştırması. Ortak teknik protokol 54 kontroldür. Beklentiyi sağlamayan kontrol başarısız kalır; eşikler sonuçlara göre oynatılmaz. Yeni modelin vektör boyutu adapter metadata'sından gelir.

HTML raporu ve katalogdaki `completed` çalıştırma aşamalarının tamamlandığı anlamındadır; bütün cevapların doğru olduğu anlamına gelmez. `incomplete` ve `interrupted` kayıtları tam değerlendirmeden ayrılır. JSON doğruluğu, etiket eşleşmesi, arama ölçüleri ve WER normal kodla hesaplanır. Doğallık veya kapsamlı olgu sadakati için ücretli bir LLM hakemi kullanılmaz; bunların yerine insan değerlendirmesi gerektiği belirtilir.

İki otomatik koşu aynı protokol ve veri özetine sahipse, en fazla bir model/sürüm bileşeninin değiştiği önceki uygun koşuyla karşılaştırma sunulur. Tarih, makine yükü, tarayıcı yaması ve SpeechT5 rastgeleliği yüzünden tek süre/puan farkına nedensellik yüklenmez. 4.3.1/4.3.2 tarihsel araştırma dosyaları değiştirilmez.

## Kaynak ve bellek sınırları

Varsayılan: en fazla 900 MiB yeni model varlığı, kontrol başına 1.100 MiB yeni indirme, 20 GiB model önbelleği, başlangıçta en az 2 GiB boş sistem belleği, en fazla bir iş ve iş başına 30 dakika. Bunlar `config.json` içinde değiştirilebilir. Yetersiz başlangıç belleğinde iş sırada kalır. Model büyüklüğü, gerçek RAM ihtiyacını garanti etmez; çalışma sırasında hata oluşursa eksik koşu kaydı tutulur. Zaman aşımında yalnız bu çalıştırıcının başlattığı işlem ağacı sonlandırılır. Eski deneyler otomatik silinmez.

Model baytları indirmede boyut ve varsa kaynak SHA-256 değeriyle, tekrar kullanımda içerik özetiyle denetlenir. Sabit başlangıç varlıkları mevcut doğrulanmış önbellekten alınabilir. Bunların kullanılması ilk internet indirme hızı testi değildir.

## Dosyalar ve yayın

`config.json` takip listesi ve politikadır. `templates/` sürüm parametreli test protokolüdür. `fixtures/` test girdileridir. `seed/` başlangıç model revizyonları ve varlık manifestleridir. `.state/state.json` kuyruk ve koşu geçmişidir. `.state/jobs/RUN_ID/` ham sonuç ve yerel günlükleri korur. `.state/publish.log` ve `monitor.log` işletim günlükleridir.

`local.json` makineye özgü Node, npm, Playwright, Edge ve Vercel yollarını içerir; yayımlanmaz. Başka makinede `local.example.json` dosyasını kopyalayıp bu yolları düzenleyin. Node.js, Playwright ve Edge gerekir. Vercel CLI'ye o kullanıcıyla giriş yapılmalıdır. Vercel oturumu sona ererse ölçümler yerelde kalır; yayın günlüğünü kontrol edip yeniden giriş yapın. Daha sonra `publish` komutu kayıtları gönderebilir.

Herkese açık çıktı `research-portal/dist/lab/` altına hazırlanır. Yalnız raporlar, JSON kanıtları, sentetik sesler ve test ekran görüntüsü aktarılır. Model ağırlıkları, speaker embedding, makine ayarları ve yerel günlükler gönderilmez. Kişisel yerel yollar ve geçici indirme URL imzaları temizlenir. Yayın, mevcut Vercel projesindeki statik dosyaları günceller; Vercel'de model çalıştırmaz.

## Geliştirici doğrulaması

```powershell
node --test lab/core.test.mjs
node lab/cli.mjs run --version 4.3.2 --force
```

Birim kontrolleri yeni model/commit kuyruğunu taklit eden ağ yanıtlarını, tekrar çalıştırmayı önlemeyi, başarısız keşfi yeniden denemeyi, ana sürüm sınırını, dosya yolu sınırlarını, adapter uyumunu ve halka açık kopyanın temizliğini denetler. Gerçek CPU/WASM koşuları ayrı kanıt klasörlerinde bulunur.
