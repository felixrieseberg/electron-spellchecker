import {CompositeDisposable, Disposable, Observable, Scheduler, SerialDisposable, Subject} from 'rx';
import {getInstalledKeyboardLanguages} from 'keyboard-layout';
import {spawn} from 'spawn-rx';

import './custom-operators';
import DictionarySync from './dictionary-sync';
import {normalizeLanguageCode} from './utility';
import FakeLocalStorage from './fake-local-storage';

import {Spellchecker} from './node-spellchecker';

let d = require('debug-electron')('electron-spellchecker:spell-check-handler');

let cld = null;
let fallbackLocaleTable = null;
let webFrame = (process.type === 'renderer' ?
  require('electron').webFrame :
  null);

// NB: Linux and Windows uses underscore in languages (i.e. 'en_US'), whereas
// we're trying really hard to match the Chromium way of `en-US`
const validLangCodeWindowsLinux = /[a-z]{2}[_][A-Z]{2}/;

// NB: This is to work around electron/electron#1005, where contractions
// are incorrectly marked as spelling errors. This lets people get away with
// incorrectly spelled contracted words, but it's the best we can do for now.
const contractions = [
  "ain't", "aren't", "can't", "could've", "couldn't", "couldn't've", "didn't", "doesn't", "don't", "hadn't",
  "hadn't've", "hasn't", "haven't", "he'd", "he'd've", "he'll", "he's", "how'd", "how'll", "how's", "I'd",
  "I'd've", "I'll", "I'm", "I've", "isn't", "it'd", "it'd've", "it'll", "it's", "let's", "ma'am", "mightn't",
  "mightn't've", "might've", "mustn't", "must've", "needn't", "not've", "o'clock", "shan't", "she'd", "she'd've",
  "she'll", "she's", "should've", "shouldn't", "shouldn't've", "that'll", "that's", "there'd", "there'd've",
  "there're", "there's", "they'd", "they'd've", "they'll", "they're", "they've", "wasn't", "we'd", "we'd've",
  "we'll", "we're", "we've", "weren't", "what'll", "what're", "what's", "what've", "when's", "where'd",
  "where's", "where've", "who'd", "who'll", "who're", "who's", "who've", "why'll", "why're", "why's", "won't",
  "would've", "wouldn't", "wouldn't've", "y'all", "y'all'd've", "you'd", "you'd've", "you'll", "you're", "you've"
];

const contractionMap = contractions.reduce((acc, word) => {
  acc[word.replace(/'.*/, '')] = true;
  return acc;
}, {});

/**
 * This method mimics Observable.fromEvent, but with capture semantics.
 */
function fromEventCapture(element, name) {
  return Observable.create((subj) => {
    const handler = function(...args) {
      if (args.length > 1) {
        subj.onNext(args);
      } else {
        subj.onNext(args[0] || true);
      }
    };

    element.addEventListener(name, handler, true);
    return Disposable.create(() => element.removeEventListener(name, handler, true));
  });
}

/**
 * SpellCheckHandler is the main class of this library, and handles all of the
 * different pieces of spell checking except for the context menu information.
 *
 * Instantiate the class, then call {{attachToInput}} to wire it up. The spell
 * checker will attempt to automatically check the language that the user is 
 * typing in and switch on-the fly. However, giving it an explicit hint by 
 * calling {{switchLanguage}}, or providing it a block of sample text via 
 * {{provideHintText}} will result in much better results.
 *
 * Sample text should be text that is reasonably likely to be in the same language
 * as the user typing - for example, in an Email reply box, the original Email text
 * would be a great sample, or in the case of Slack, the existing channel messages
 * are used as the sample text.
 */
export default class SpellCheckHandler {
  /**
   * Constructs a SpellCheckHandler
   * 
   * @param  {DictionarySync} dictionarySync  An instance of {{DictionarySync}},
   *                                          create a custom one if you want
   *                                          to override the dictionary cache
   *                                          location.
   * @param  {LocalStorage} localStorage      An implementation of localStorage
   *                                          used for testing.
   * @param  {Scheduler} scheduler            The Rx scheduler to use, for 
   *                                          testing.
   */
  constructor(dictionarySync=null, localStorage=null, scheduler=null) {
    this.dictionarySync = dictionarySync || new DictionarySync();
    this.switchToLanguage = new Subject();
    this.currentSpellchecker = null;
    this.currentSpellcheckerLanguage = null;
    this.currentSpellcheckerChanged = new Subject();
    this.spellCheckInvoked = new Subject();
    this.spellingErrorOccurred = new Subject();

    this.scheduler = scheduler || Scheduler.default;
    this.shouldAutoCorrect = true;

    // NB: A Cool thing is when window.localStorage is rigged to blow up
    // if you touch it from a data: URI in Chromium.
    try {
      this.localStorage = localStorage || window.localStorage || new FakeLocalStorage();
    } catch (ugh) {
      this.localStorage = new FakeLocalStorage();
    }

    this.disp = new SerialDisposable();

    if (process.platform === 'darwin') {
      // NB: OS X does automatic language detection, we're gonna trust it
      this.currentSpellchecker = new Spellchecker();
      this.currentSpellcheckerLanguage = 'en-US';

      if (webFrame) {
        webFrame.setSpellCheckProvider(
          this.currentSpellcheckerLanguage,
          this.shouldAutoCorrect,
          { spellCheck: this.handleElectronSpellCheck.bind(this) });
      }
      return;
    }
  }
    
  /**
   * Disconnect the events that we connected in {{attachToInput}} or other places
   * in the class.
   */  
  dispose() {
    this.disp.dispose();
  }

  /**
   * Override the default logger for this class. You probably want to use
   * {{setGlobalLogger}} instead
   * 
   * @param {Function} fn   The function which will operate like console.log
   */  
  static setLogger(fn) {
    d = fn;
  }
  
  /**
   * Attach to document.body and register ourselves for Electron spell checking.
   * This method will start to watch text entered by the user and automatically
   * switch languages as well as enable Electron spell checking (i.e. the red
   * squigglies).
   * 
   * @param  {Observable<String>} inputText     Simulate the user typing text,
   *                                            for testing.
   *
   * @return {Disposable}       A Disposable which will unregister all of the 
   *                            things that this method registered.
   */
  attachToInput(inputText=null) {
    // OS X has no need for any of this
    if (process.platform === 'darwin' && !inputText) {
      return Disposable.empty;
    }

    let possiblySwitchedCharacterSets = new Subject();
    let wordsTyped = 0;

    let input = inputText || (fromEventCapture(document.body, 'input')
      .flatMap((e) => {
        if (!e.target || !e.target.value) return Observable.empty();
        if (e.target.value.match(/\S\s$/)) {
          wordsTyped++;
        }

        if (wordsTyped > 2) {
          d(`${wordsTyped} words typed without spell checking invoked, redetecting language`);
          possiblySwitchedCharacterSets.onNext(true);
        }

        return Observable.just(e.target.value);
      }));

    let disp = new CompositeDisposable();

    // NB: When users switch character sets (i.e. we're checking in English and
    // the user suddenly starts typing in Russian), the spellchecker will no
    // longer invoke us, so we don't have a chance to re-detect the language.
    //
    // If we see too many words typed without a spelling detection, we know we
    // should start rechecking the input box for a language change.
    disp.add(Observable.merge(this.spellCheckInvoked, this.currentSpellcheckerChanged)
      .subscribe(() => wordsTyped = 0));


    let lastInputText = '';
    disp.add(input.subscribe((x) => lastInputText = x));

    let initialInputText = input
      .guaranteedThrottle(250, this.scheduler)
      .takeUntil(this.currentSpellcheckerChanged);

    if (this.currentSpellcheckerLanguage) {
      initialInputText = Observable.empty();
    }

    let contentToCheck = Observable.merge(
        this.spellingErrorOccurred,
        initialInputText,
        possiblySwitchedCharacterSets)
      .observeOn(this.scheduler)
      .flatMap(() => {
        if (lastInputText.length < 8) return Observable.empty();
        return Observable.just(lastInputText);
      });

    let languageDetectionMatches = contentToCheck
      .flatMap((text) => {
        d(`Attempting detection of text with length ${text.length}`);
        return Observable.fromPromise(this.detectLanguageForText(text))
          .catch(() => Observable.empty());
      });

    disp.add(languageDetectionMatches
      .flatMap(async (langWithoutLocale) => {
        d(`Auto-detected language as ${langWithoutLocale}`);
        let lang = await this.getLikelyLocaleForLanguage(langWithoutLocale);
        if (lang !== this.currentSpellcheckerLanguage) await this.switchLanguage(lang);

        return lang;
      })
      .catch((e) => {
        d(`Failed to load dictionary: ${e.message}`);
        return Observable.empty();
      })
      .subscribe(async (lang) => {
        d(`New Language is ${lang}`);
      }));

    if (webFrame) {
      disp.add(this.currentSpellcheckerChanged
          .startWith(true)
          .observeOn(this.scheduler)
        .where(() => this.currentSpellchecker)
        .subscribe(() => {
          d('Actually installing spell check provider to Electron');

          webFrame.setSpellCheckProvider(
            this.currentSpellcheckerLanguage,
            this.shouldAutoCorrect,
            { spellCheck: this.handleElectronSpellCheck.bind(this) });
        }));
    }

    this.disp.setDisposable(disp);
    return disp;
  }
  
  /**
   * autoUnloadDictionariesOnBlur attempts to save memory by unloading 
   * dictionaries when the window loses focus.
   * 
   * @return {Disposable}   A {{Disposable}} that will unhook the events listened
   *                        to by this method.
   */
  autoUnloadDictionariesOnBlur() {
    let ret = new CompositeDisposable();
    let hasUnloaded = false;

    if (process.platform === 'darwin') return Disposable.empty;

    ret.add(Observable.fromEvent(window, 'blur').subscribe(() => {
      d(`Unloading spellchecker`);
      this.currentSpellchecker = null;
      hasUnloaded = true;
    }));

    ret.add(Observable.fromEvent(window, 'focus').flatMap(() => {
      if (!hasUnloaded) return Observable.empty();
      if (!this.currentSpellcheckerLanguage) return Observable.empty();

      d(`Restoring spellchecker`);
      return Observable.fromPromise(this.switchLanguage(this.currentSpellcheckerLanguage))
        .catch((e) => {
          d(`Failed to restore spellchecker: ${e.message}`);
          return Observable.empty();
        });
    }).subscribe());

    return ret;
  }
  
  /**
   * Switch the dictionary language to the language of the sample text provided.
   * As described in the class documentation, call this method with text most 
   * likely in the same language as the user is typing. The locale (i.e. *US* vs
   * *UK* vs *AU*) will be inferred heuristically based on the user's computer.
   * 
   * @param  {String} inputText   A language code (i.e. 'en-US')
   * 
   * @return {Promise}            Completion
   */
  async provideHintText(inputText) {
    let langWithoutLocale = null;
    try {
      langWithoutLocale = await this.detectLanguageForText(inputText);
    } catch (e) {
      d(`Couldn't detect language for text with length '${inputText.length}': ${e.message}, ignoring sample`);
      return;
    }

    let lang = await this.getLikelyLocaleForLanguage(langWithoutLocale);
    await this.switchLanguage(lang);
  }

  /**
   * Explicitly switch the language to a specific language. This method will 
   * automatically download the dictionary for the specific language and locale
   * and on failure, will attempt to switch to dictionaries that are the same
   * language but a default locale.
   * 
   * @param  {String} langCode    A language code (i.e. 'en-US')
   * 
   * @return {Promise}            Completion
   */
  async switchLanguage(langCode) {
    let actualLang;
    let dict = null;

    try {
      let {dictionary, language} = await this.loadDictionaryForLanguageWithAlternatives(langCode);
      actualLang = language;  dict = dictionary;
    } catch (e) {
      d(`Failed to load dictionary ${langCode}: ${e.message}`);
      throw e;
    }

    d(`Setting current spellchecker to ${actualLang}, requested language was ${langCode}`);
    if (this.currentSpellcheckerLanguage !== actualLang || !this.currentSpellchecker) {
      d(`Creating node-spellchecker instance`);
      this.currentSpellchecker = new Spellchecker();
      this.currentSpellchecker.setDictionary(actualLang, dict);
      this.currentSpellcheckerLanguage = actualLang;
      this.currentSpellcheckerChanged.onNext(true);
    }
  }

  /**
   * Loads a dictionary and attempts to use fallbacks if it fails.
   * @private
   */
  async loadDictionaryForLanguageWithAlternatives(langCode, cacheOnly=false) {
    const localStorageKey =  'electronSpellchecker_alternatesTable';

    this.fallbackLocaleTable = this.fallbackLocaleTable || require('./fallback-locales');
    let lang = langCode.substring(0, 2);

    let alternatives = [langCode, await this.getLikelyLocaleForLanguage(lang), this.fallbackLocaleTable[lang]];
    let alternatesTable = JSON.parse(this.localStorage.getItem(localStorageKey) || '{}');

    if (langCode in alternatesTable) {
      try {
        return {
          language: alternatesTable[langCode],
          dictionary: await this.dictionarySync.loadDictionaryForLanguage(alternatesTable[langCode])
        };
      } catch (e) {
        // If we fail to load a saved alternate, this is an indicator that our
        // data is garbage and we should throw it out entirely.
        this.localStorage.setItem(localStorageKey, '{}');
      }
    }

    d(`Requesting to load ${langCode}, alternatives are ${JSON.stringify(alternatives)}`);
    return await Observable.of(...alternatives)
      .concatMap((l) => {
        return Observable.defer(() =>
            Observable.fromPromise(this.dictionarySync.loadDictionaryForLanguage(l, cacheOnly)))
          .map((d) => ({language: l, dictionary: d}))
          .do(({language}) => {
            alternatesTable[langCode] = language;
            this.localStorage.setItem(localStorageKey, JSON.stringify(alternatesTable));
          })
          .catch(() => Observable.just(null));
      })
      .filter((x) => x !== null)
      .take(1)
      .toPromise();
  }

  /**
   *  The actual callout called by Electron to handle spellchecking
   *  @private
   */
  handleElectronSpellCheck(text) {
    if (!this.currentSpellchecker) return true;
    this.spellCheckInvoked.onNext(true);

    if (contractionMap[text.toLocaleLowerCase()]) return true;

    // NB: I'm not smart enough to fix this bug in Chromium's version of
    // Hunspell so I'm going to fix it here instead. Chromium Hunspell for
    // whatever reason marks the first word in a sentence as mispelled if it is
    // capitalized.
    let result = this.currentSpellchecker.checkSpelling(text);
    if (result.length < 1) return true;
    if (result[0].start !== 0) {
      this.spellingErrorOccurred.onNext(text);
      return false;
    }

    let ret = this.currentSpellchecker.isMisspelled(text.toLocaleLowerCase());
    if (ret) {
      this.spellingErrorOccurred.onNext(text);
    }

    return !ret;
  }

  /**
   * Calls out to cld2 to detect the language of the given text
   * @private
   */
  detectLanguageForText(text) {
    // NB: Unfortuantely cld marshals errors incorrectly, so we can't use pify
    cld = cld || require('cld');

    return new Promise((res,rej) => {
      cld.detect(text, (err, result) => {
        if (err) { rej(new Error(err.message)); return; }
        if (!result.reliable || result.languages[0].percent < 85) {
          rej(new Error('Not enough reliable text'));
          return;
        }

        res(result.languages[0].code);
      });
    });
  }

  /**
   * Returns the locale for a language code based on the user's machine (i.e. 
   * 'en' => 'en-GB')
   */
  async getLikelyLocaleForLanguage(language) {
    let lang = language.toLowerCase();
    if (!this.likelyLocaleTable) this.likelyLocaleTable = await this.buildLikelyLocaleTable();

    if (this.likelyLocaleTable[lang]) return this.likelyLocaleTable[lang];
    this.fallbackLocaleTable = this.fallbackLocaleTable || require('./fallback-locales');

    return this.fallbackLocaleTable[lang];
  }

  /**
   * A proxy for the current spellchecker's method of the same name
   * @private
   */
  async getCorrectionsForMisspelling(text) {
    // NB: This is async even though we don't use await, to make it easy for
    // ContextMenuBuilder to use this method even when it's hosted in another
    // renderer process via electron-remote.
    if (!this.currentSpellchecker) {
      return null;
    }

    return this.currentSpellchecker.getCorrectionsForMisspelling(text);
  }

  /**
   * A proxy for the current spellchecker's method of the same name
   * @private
   */
  async addToDictionary(text) {
    // NB: Same deal as getCorrectionsForMisspelling.
    if (process.platform !== 'darwin') return;
    if (!this.currentSpellchecker) return;

    this.currentSpellchecker.add(text);
  }

  /**
   * Call out to the OS to figure out what locales the user is probably 
   * interested in then save it off as a table.
   * @private
   */
  async buildLikelyLocaleTable() {
    let localeList = [];

    if (process.platform === 'linux') {
      let locales = await spawn('locale', ['-a'])
        .catch(() => Observable.just(null))
        .reduce((acc,x) => { acc.push(...x.split('\n')); return acc; }, [])
        .toPromise();

      d(`Raw Locale list: ${JSON.stringify(locales)}`);

      localeList = locales.reduce((acc, x) => {
        let m = x.match(validLangCodeWindowsLinux);
        if (!m) return acc;

        acc.push(m[0]);
        return acc;
      }, []);
    }

    if (process.platform === 'win32') {
      localeList = getInstalledKeyboardLanguages();
    }

    if (process.platform === 'darwin') {
      fallbackLocaleTable = fallbackLocaleTable || require('./fallback-locales');

      // NB: OS X will return lists that are half just a language, half
      // language + locale, like ['en', 'pt_BR', 'ko']
      localeList = this.currentSpellchecker.getAvailableDictionaries()
        .map((x => {
          if (x.length === 2) return fallbackLocaleTable[x];
          return normalizeLanguageCode(x);
        }));
    }

    d(`Filtered Locale list: ${JSON.stringify(localeList)}`);

    // Some distros like Ubuntu make locale -a useless by dumping
    // every possible locale for the language into the list :-/
    let counts = localeList.reduce((acc,x) => {
      let k = x.substring(0,2);
      acc[k] = acc[k] || [];
      acc[k].push(x);

      return acc;
    }, {});

    d(`Counts: ${JSON.stringify(counts)}`);

    let ret = Object.keys(counts).reduce((acc, x) => {
      if (counts[x].length > 1) return acc;

      d(`Setting ${x}`);
      acc[x] = normalizeLanguageCode(counts[x][0]);

      return acc;
    }, {});

    // NB: LANG has a Special Place In Our Hearts
    if (process.platform === 'linux' && process.env.LANG) {
      let m = process.env.LANG.match(validLangCodeWindowsLinux);
      if (!m) return ret;

      ret[m[0].substring(0, 2)] = normalizeLanguageCode(m[0]);
    }

    d(`Result: ${JSON.stringify(ret)}`);
    return ret;
  }
}
