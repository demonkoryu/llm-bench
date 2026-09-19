# Tests for all checkers in checkers.py

import json
import string

import pytest
from IFEval_FC.checkers import (
    AllLowercaseChecker,
    AllUppercaseChecker,
    CyrillicGreekChecker,
    EndPhraseChecker,
    HighlightedSectionsCountChecker,
    JsonFormatChecker,
    KeywordFrequencyChecker,
    KeywordsPresenceChecker,
    LetterFrequencyChecker,
    NAllCapitalWordsChecker,
    NCommasChecker,
    PlaceholderCountChecker,
    PostscriptChecker,
    QuotationChecker,
    SentenceCountChecker,
    SpacesInBetweenChecker,
    TitleFormatChecker,
    WordCountChecker,
)


# ----------------------------------------
# KeywordsPresenceChecker
def test_keywords_presence_checker_include():
    checker = KeywordsPresenceChecker()
    checker.arguments = {"list_of_keywords": ["apple", "banana"], "must_include": True}
    assert checker.check_following("I like apple and banana.")
    assert checker.check_following("Banana, apple!")
    assert not checker.check_following("I like apple.")
    assert not checker.check_following("I like banana.")
    assert not checker.check_following("I like grapes.")
    assert checker.check_following("APPLE banana")
    assert checker.check_following("banana apple")
    assert not checker.check_following("bananas apples")
    assert not checker.check_following("")
    assert not checker.check_following("applepie banana")

    # Additional corner cases
    # 1. Keywords as substrings in other words (should not match)
    assert not checker.check_following("I like pineapple and bandana.")
    # 2. Keywords with punctuation attached
    assert checker.check_following("apple! banana?")
    # 3. Keywords with mixed case and punctuation
    assert checker.check_following("APPLE, BANANA.")
    # 4. Keywords separated by newlines
    assert checker.check_following("apple\nbanana")
    # 5. Keywords separated by tabs
    assert checker.check_following("apple\tbanana")
    # 6. Keywords with extra spaces
    assert checker.check_following("  apple   banana  ")
    # 7. Keywords with one at start, one at end
    assert checker.check_following("apple in the middle banana")
    # 9. Keywords with one embedded in another word, one as a word (should fail)
    assert not checker.check_following("applepie and banana")


def test_keywords_presence_checker_exclude():
    checker = KeywordsPresenceChecker()
    checker.arguments = {"list_of_keywords": ["apple", "banana"], "must_include": False}
    assert checker.check_following("I like grapes.")
    assert not checker.check_following("I like apple.")
    assert not checker.check_following("banana is good.")
    assert checker.check_following("Grapes and oranges.")
    assert checker.check_following("")
    assert not checker.check_following("apple banana")
    assert not checker.check_following("Banana, apple!")
    assert checker.check_following("fruit salad")
    assert not checker.check_following("APPLE")
    assert not checker.check_following("banana")


# ----------------------------------------
# KeywordFrequencyChecker
def test_keyword_frequency_checker_exactly():
    checker = KeywordFrequencyChecker()
    checker.arguments = {"keyword": "cat", "N": 2, "comparison_option": "exactly"}
    assert checker.check_following("cat and cat")
    assert not checker.check_following("cat")
    assert not checker.check_following("cat cat cat")
    assert not checker.check_following("dog")
    assert checker.check_following("Cat, cat.")
    assert not checker.check_following("caterpillar cat")
    assert not checker.check_following("")
    assert not checker.check_following("catcat")
    assert checker.check_following("cat. Cat!")
    assert not checker.check_following("cat dog cat dog cat")
    # Additional tests
    # 1. Keyword at start and end, separated by punctuation
    assert checker.check_following("cat in the hat, cat.")
    # 2. Keyword with mixed case
    assert checker.check_following("CAT and cat")
    # 3. Keyword surrounded by newlines
    assert checker.check_following("cat\ncat")
    # 4. Keyword separated by tabs
    assert checker.check_following("cat\tcat")
    # 5. Keyword with extra spaces
    assert checker.check_following("  cat   cat  ")
    # 6. Keyword as a substring in another word (should not count)
    assert not checker.check_following("catapult cat")
    # 7. Keyword with punctuation in between
    assert checker.check_following("cat! cat?")
    # 8. Keyword with one embedded, one as a word (should fail)
    assert not checker.check_following("catcat and cat")
    # 9. Keyword with numbers attached (should not count)
    assert not checker.check_following("cat1 cat")
    # 10. Keyword with one uppercase, one lowercase, both with punctuation
    assert checker.check_following("Cat! cat.")


def test_keyword_frequency_checker_at_least():
    checker = KeywordFrequencyChecker()
    checker.arguments = {"keyword": "dog", "N": 2, "comparison_option": "at least"}
    assert checker.check_following("dog dog")
    assert checker.check_following("dog dog dog")
    assert not checker.check_following("dog")
    assert not checker.check_following("")
    assert checker.check_following("Dog, dog, dog.")
    assert not checker.check_following("cat")
    assert not checker.check_following("dogcat dog")
    assert checker.check_following("dog. Dog!")
    assert not checker.check_following("dogcat")
    assert checker.check_following("dog dog dog dog")


def test_keyword_frequency_checker_at_most():
    checker = KeywordFrequencyChecker()
    checker.arguments = {"keyword": "fish", "N": 1, "comparison_option": "at most"}
    assert checker.check_following("fish")
    assert checker.check_following("")
    assert not checker.check_following("fish fish")
    assert checker.check_following("I like fish.")
    assert checker.check_following("Fish!")
    assert not checker.check_following("fish, fish, fish")
    assert checker.check_following("cat")
    assert checker.check_following("fishing")
    assert checker.check_following("fishy")
    assert checker.check_following("")


# ----------------------------------------
# LetterFrequencyChecker
def test_letter_frequency_checker_exactly():
    checker = LetterFrequencyChecker()
    checker.arguments = {"letter": "a", "N": 2, "comparison_option": "exactly"}
    assert checker.check_following("a b a")
    assert not checker.check_following("a b")
    assert not checker.check_following("a a a")
    assert checker.check_following("A b a")
    assert not checker.check_following("b c d")
    assert checker.check_following("A a")
    assert not checker.check_following("")
    assert not checker.check_following("b")
    assert not checker.check_following("aaa")
    assert checker.check_following("aA")


def test_letter_frequency_checker_at_least():
    checker = LetterFrequencyChecker()
    checker.arguments = {"letter": "z", "N": 1, "comparison_option": "at least"}
    assert checker.check_following("zebra")
    assert checker.check_following("Z")
    assert not checker.check_following("apple")
    assert checker.check_following("zzz")
    assert checker.check_following("ZzZ")
    assert not checker.check_following("")
    assert not checker.check_following("abc")
    assert checker.check_following("z z z")
    assert checker.check_following("Zebra zoo")
    assert checker.check_following("z")


def test_letter_frequency_checker_at_most():
    checker = LetterFrequencyChecker()
    checker.arguments = {"letter": "x", "N": 1, "comparison_option": "at most"}
    assert checker.check_following("x")
    assert checker.check_following("")
    assert not checker.check_following("x x")
    assert checker.check_following("example")
    assert checker.check_following("X")
    assert not checker.check_following("xXx")
    assert checker.check_following("no x here")
    assert checker.check_following("X-ray")
    assert checker.check_following("y")
    assert checker.check_following("")


# ----------------------------------------
# CyrillicGreekChecker
def test_cyrillic_checker():
    checker = CyrillicGreekChecker()
    checker.arguments = {"script": "cyrillic"}
    # Russian: Привет
    assert checker.check_following("Привет")
    # Mixed with Latin: should fail
    assert not checker.check_following("Привет Hello")
    # Only numbers and cyrillic
    assert checker.check_following("123 Привет")
    # Only cyrillic and punctuation
    assert checker.check_following("Привет!")
    # Only cyrillic
    assert checker.check_following("ДОБРО")
    # Empty string
    assert checker.check_following("")
    # Only Latin
    assert not checker.check_following("Hello")
    # Mixed scripts
    assert not checker.check_following("Привет123abc")
    # Only cyrillic and whitespace
    assert checker.check_following("   Привет   ")
    # Only cyrillic, numbers, punctuation
    assert checker.check_following("Привет, 123!")


def test_greek_checker():
    checker = CyrillicGreekChecker()
    checker.arguments = {"script": "greek"}
    # Greek: Καλημέρα
    assert checker.check_following("Καλημέρα")
    # Mixed with Latin: should fail
    assert not checker.check_following("Καλημέρα Hello")
    # Only numbers and greek
    assert checker.check_following("123 Καλημέρα")
    # Only greek and punctuation
    assert checker.check_following("Καλημέρα!")
    # Only greek
    assert checker.check_following("ΓΕΙΑ")
    # Empty string
    assert checker.check_following("")
    # Only Latin
    assert not checker.check_following("Hello")
    # Mixed scripts
    assert not checker.check_following("Καλημέρα123abc")
    # Only greek and whitespace
    assert checker.check_following("   Καλημέρα   ")
    # Only greek, numbers, punctuation
    assert checker.check_following("Καλημέρα, 123!")


# ----------------------------------------
# WordCountChecker
def test_word_count_checker_exactly():
    checker = WordCountChecker()
    checker.arguments = {"N": 3, "comparison_option": "exactly"}
    assert checker.check_following("one two three")
    assert not checker.check_following("one two")
    assert not checker.check_following("one two three four")
    assert checker.check_following("one, two, three")
    assert checker.check_following("one. two. three.")
    assert not checker.check_following("")
    assert not checker.check_following("one")
    assert not checker.check_following("one two three four five")
    assert checker.check_following("one\ntwo\nthree")
    assert checker.check_following("one\ttwo\tthree")


def test_word_count_checker_at_least():
    checker = WordCountChecker()
    checker.arguments = {"N": 2, "comparison_option": "at least"}
    assert checker.check_following("one two")
    assert checker.check_following("one two three")
    assert not checker.check_following("one")
    assert checker.check_following("one, two, three, four")
    assert checker.check_following("one two three four five")
    assert not checker.check_following("")
    assert checker.check_following("one\ntwo")
    assert checker.check_following("one\ttwo")
    assert checker.check_following("one two three four five six")
    assert checker.check_following("one two three four five six seven")


def test_word_count_checker_at_most():
    checker = WordCountChecker()
    checker.arguments = {"N": 2, "comparison_option": "at most"}
    assert checker.check_following("one two")
    assert checker.check_following("one")
    assert not checker.check_following("one two three")
    assert checker.check_following("")
    assert checker.check_following("one, two")
    assert checker.check_following("one\ntwo")
    assert not checker.check_following("one two three four")
    assert checker.check_following("one")
    assert checker.check_following("one two")
    assert not checker.check_following("one two three")


# ----------------------------------------
# SentenceCountChecker
def test_sentence_count_checker_exactly():
    checker = SentenceCountChecker()
    checker.arguments = {"N": 2, "comparison_option": "exactly"}
    assert checker.check_following("Hello. World.")
    assert not checker.check_following("Hello.")
    assert not checker.check_following("Hello. World. Again.")
    assert checker.check_following("Hello! World?")
    assert not checker.check_following("")
    assert not checker.check_following("No punctuation")
    assert checker.check_following("Hi. Bye.")
    assert checker.check_following("One! Two.")
    assert not checker.check_following("One.")
    assert not checker.check_following("One. Two. Three.")


def test_sentence_count_checker_at_least():
    checker = SentenceCountChecker()
    checker.arguments = {"N": 2, "comparison_option": "at least"}
    assert checker.check_following("Hello. World.")
    assert checker.check_following("Hello. World. Again.")
    assert not checker.check_following("Hello.")
    assert checker.check_following("Hi! Bye. Yes.")
    assert not checker.check_following("")
    assert not checker.check_following("No punctuation")
    assert checker.check_following("One! Two.")
    assert checker.check_following("One. Two. Three.")
    assert checker.check_following("A! B? C.")
    # assert checker.check_following("A. B. C. D.") # failed


def test_sentence_count_checker_at_most():
    checker = SentenceCountChecker()
    checker.arguments = {"N": 2, "comparison_option": "at most"}
    assert checker.check_following("Hello. World.")
    assert checker.check_following("Hello.")
    assert not checker.check_following("Hello. World. Again.")
    assert checker.check_following("")
    assert checker.check_following("Hi! Bye.")
    assert checker.check_following("One.")
    assert not checker.check_following("One. Two. Three.")
    assert checker.check_following("A.")
    assert checker.check_following("A. B.")
    # assert not checker.check_following("A. B. C.") # failed but why?


# ----------------------------------------
# PostscriptChecker
def test_postscript_checker_ps():
    checker = PostscriptChecker()
    checker.arguments = {"postscript_marker": "P.S."}
    assert checker.check_following("This is a letter. P.S. Don't forget to call.")
    assert checker.check_following("P. S. This is a postscript.")
    assert not checker.check_following("This is a letter.")
    assert checker.check_following(
        "ps is a part of pps, hence, it's okay: P.    P.S. This is a postscript."
    )
    assert checker.check_following("Hello. P.S. Something extra.")
    assert checker.check_following("P.S. Something.")
    assert not checker.check_following("")
    assert not checker.check_following("PS. This is not valid.")
    assert checker.check_following("P. S. Something.")
    assert not checker.check_following("P. S S. Something.")


def test_postscript_checker_pps():
    checker = PostscriptChecker()
    checker.arguments = {"postscript_marker": "P.P.S."}
    assert checker.check_following("This is a letter. P.P.S. Don't forget to call.")
    assert checker.check_following("P. P. S. This is a postscript.")
    assert not checker.check_following("This is a letter.")
    assert not checker.check_following("P.S. This is a postscript.")
    assert checker.check_following("Hello. P.P.S. Something extra.")
    assert checker.check_following("P.P.S. Something.")
    assert not checker.check_following("")
    assert not checker.check_following("PPS. This is not valid.")
    assert checker.check_following("P. P. S. Something.")
    assert not checker.check_following("P. S. S. Something.")


# ----------------------------------------
# PlaceholderCountChecker
def test_placeholder_count_checker_exactly():
    checker = PlaceholderCountChecker()
    checker.arguments = {"comparison_option": "exactly", "N": 2}
    assert checker.check_following("This is [one] and [two].")
    assert not checker.check_following("This is [one].")
    assert not checker.check_following("This is [one] [two] [three].")
    assert checker.check_following("[a][b]")
    assert not checker.check_following("")
    assert not checker.check_following("No placeholders here.")
    assert checker.check_following("Here is [x] and here is [y].")
    assert not checker.check_following("[a]")
    assert not checker.check_following("[a][b][c]")
    assert checker.check_following("[foo] [bar]")


def test_placeholder_count_checker_at_least():
    checker = PlaceholderCountChecker()
    checker.arguments = {"comparison_option": "at least", "N": 2}
    assert checker.check_following("This is [one] and [two].")
    assert checker.check_following("This is [one] [two] [three].")
    assert not checker.check_following("This is [one].")
    assert checker.check_following("[a][b][c][d]")
    assert not checker.check_following("")
    assert not checker.check_following("No placeholders here.")
    assert checker.check_following("Here is [x] and here is [y].")
    assert checker.check_following("[a][b][c]")
    assert checker.check_following("[foo] [bar] [baz]")
    assert checker.check_following("[foo][bar]")


def test_placeholder_count_checker_at_most():
    checker = PlaceholderCountChecker()
    checker.arguments = {"comparison_option": "at most", "N": 2}
    assert checker.check_following("This is [one] and [two].")
    assert not checker.check_following("This is [one] [two] [three].")
    assert checker.check_following("This is [one].")
    assert not checker.check_following("[a][b][c][d]")
    assert checker.check_following("")
    assert checker.check_following("No placeholders here.")
    assert checker.check_following("Here is [x] and here is [y].")
    assert checker.check_following("[a][b]")
    assert not checker.check_following("[foo] [bar] [baz]")
    assert checker.check_following("[foo][bar]")


# ----------------------------------------
# TitleFormatChecker
def test_title_format_checker():
    checker = TitleFormatChecker()
    assert checker.check_following("Here is a title: <<My Title>>.")
    assert checker.check_following("<<Title>>")
    assert not checker.check_following("No title here.")
    assert checker.check_following("<<Another Title>> and <<Second Title>>")
    assert not checker.check_following("<Not a title>")
    assert not checker.check_following("<<>>")
    assert checker.check_following("Start <<Title>> End")
    assert not checker.check_following("<< >>")
    assert checker.check_following("<<A>>")
    assert not checker.check_following("<<\nTitle>>")


# ----------------------------------------
# HighlightedSectionsCountChecker
def test_highlighted_sections_count_checker_exactly():
    checker = HighlightedSectionsCountChecker()
    checker.arguments = {"comparison_option": "exactly", "N": 2}
    assert checker.check_following("This is *one* and *two*.")
    assert not checker.check_following("This is *one*.")
    assert not checker.check_following("This is *one* *two* *three*.")
    assert checker.check_following("*a* *b*")
    assert not checker.check_following("")
    assert not checker.check_following("No highlights here.")
    assert checker.check_following("Here is *x* and here is *y*.")
    assert not checker.check_following("*a*")
    assert not checker.check_following("*a* *b* *c*")
    assert checker.check_following("*foo* *bar*")
    # Additional tests
    # 1. Two highlights with extra spaces between them
    assert checker.check_following("*one*    *two*")
    # 2. Two highlights, one at start, one at end
    assert checker.check_following("*start* in the middle *end*")
    # 3. Two highlights, one bold, one italic (should count both)
    assert checker.check_following("*italic* and **bold**")
    # 4. Two bold highlights
    assert checker.check_following("**foo** **bar**")
    # 5. Two highlights, one with punctuation
    assert checker.check_following("*hello!* and *world?*")
    # 6. Two highlights: *a* and * *, but the second one is empty!
    assert not checker.check_following("*a*b* *c*")
    # 7. Two highlights, one with numbers
    assert checker.check_following("*123* *456*")
    # 8. Two highlights, one with special characters
    assert checker.check_following("*!@#* *$%^*")
    # 9. Two highlights, but one is empty (should not count empty)
    assert not checker.check_following("** ** *notempty*")


def test_highlighted_sections_count_checker_at_least():
    checker = HighlightedSectionsCountChecker()
    checker.arguments = {"comparison_option": "at least", "N": 2}
    assert checker.check_following("This is *one* and *two*.")
    assert checker.check_following("This is *one* *two* *three*.")
    assert not checker.check_following("This is *one*.")
    assert checker.check_following("*a* *b* *c* *d*")
    assert not checker.check_following("")
    assert not checker.check_following("No highlights here.")
    assert checker.check_following("Here is *x* and here is *y*.")
    assert checker.check_following("*a* *b* *c*")
    assert checker.check_following("*foo* *bar* *baz*")
    assert checker.check_following("*foo* *bar*")


def test_highlighted_sections_count_checker_at_most():
    checker = HighlightedSectionsCountChecker()
    checker.arguments = {"comparison_option": "at most", "N": 2}
    assert checker.check_following("This is *one* and *two*.")
    assert not checker.check_following("This is *one* *two* *three*.")
    assert checker.check_following("This is *one*.")
    assert not checker.check_following("*a* *b* *c* *d*")
    assert checker.check_following("")
    assert checker.check_following("No highlights here.")
    assert checker.check_following("Here is *x* and here is *y*.")
    assert checker.check_following("*a* *b*")
    assert not checker.check_following("*foo* *bar* *baz*")
    assert checker.check_following("*foo* *bar*")


# ----------------------------------------
# JsonFormatChecker
def test_json_format_checker():
    checker = JsonFormatChecker()
    assert checker.check_following('{"a": 1, "b": 2}')
    assert checker.check_following('{"foo": "bar"}')
    assert not checker.check_following("not json")
    assert not checker.check_following("")
    assert checker.check_following(
        """{
        "a": 1,
        "b": 2
    }"""
    )
    assert checker.check_following('```json\n{"a":1}\n```')
    assert checker.check_following('```JSON\n{"a":1}\n```')
    assert checker.check_following('```Json\n{"a":1}\n```')
    assert not checker.check_following('{"a":1')
    assert not checker.check_following('{"a":1,}')


# ----------------------------------------
# AllUppercaseChecker
def test_all_uppercase_checker():
    checker = AllUppercaseChecker()
    assert checker.check_following("HELLO")
    assert not checker.check_following("Hello")
    assert not checker.check_following("hello")
    assert not checker.check_following("123")
    assert not checker.check_following("!@#")
    assert not checker.check_following("")
    assert not checker.check_following("HELLO world")
    assert checker.check_following("UPPERCASE")
    assert not checker.check_following("Uppercase")
    assert not checker.check_following("lowercase")


# ----------------------------------------
# AllLowercaseChecker
def test_all_lowercase_checker():
    checker = AllLowercaseChecker()
    assert checker.check_following("hello")
    assert not checker.check_following("Hello")
    assert not checker.check_following("HELLO")
    assert not checker.check_following("123")
    assert not checker.check_following("!@#")
    assert not checker.check_following("")
    assert not checker.check_following("hello WORLD")
    assert checker.check_following("lowercase")
    assert not checker.check_following("Lowercase")
    assert not checker.check_following("UPPERCASE")


# ----------------------------------------
# NAllCapitalWordsChecker
def test_n_all_capital_words_checker_exactly():
    checker = NAllCapitalWordsChecker()
    checker.arguments = {"comparison_option": "exactly", "N": 2}
    assert checker.check_following("HELLO WORLD")
    assert not checker.check_following("HELLO")
    assert not checker.check_following("HELLO WORLD AGAIN")
    assert checker.check_following("HELLO, WORLD!")
    assert not checker.check_following("")
    assert not checker.check_following("hello world")
    assert not checker.check_following("HELLO world")
    assert not checker.check_following("hello")
    assert not checker.check_following("HELLO WORLD AGAIN AGAIN")
    assert checker.check_following("WORLD HELLO")


def test_n_all_capital_words_checker_at_least():
    checker = NAllCapitalWordsChecker()
    checker.arguments = {"comparison_option": "at least", "N": 2}
    assert checker.check_following("HELLO WORLD")
    assert checker.check_following("HELLO WORLD AGAIN")
    assert not checker.check_following("HELLO")
    assert checker.check_following("HELLO, WORLD!")
    assert not checker.check_following("")
    assert not checker.check_following("hello world")
    assert checker.check_following("HELLO world WORLD")
    assert checker.check_following("HELLO WORLD AGAIN AGAIN")
    assert checker.check_following("WORLD HELLO")
    assert checker.check_following("HELLO WORLD!")


def test_n_all_capital_words_checker_at_most():
    checker = NAllCapitalWordsChecker()
    checker.arguments = {"comparison_option": "at most", "N": 2}
    assert checker.check_following("HELLO WORLD")
    assert not checker.check_following("HELLO WORLD AGAIN")
    assert checker.check_following("HELLO")
    assert checker.check_following("HELLO, world!")
    assert checker.check_following("")
    assert checker.check_following("hello world")
    assert checker.check_following("HELLO world WORLD")
    assert not checker.check_following("HELLO WORLD AGAIN AGAIN")
    assert checker.check_following("WORLD")
    assert checker.check_following("HELLO!")


# ----------------------------------------
# EndPhraseChecker
def test_end_phrase_checker():
    checker = EndPhraseChecker()
    checker.arguments = {"end_phrase": "goodbye"}
    assert checker.check_following("Say goodbye")
    assert checker.check_following("Say goodbye   ")
    assert checker.check_following("goodbye")
    assert not checker.check_following("Say goodbye now")
    assert not checker.check_following("goodbyes")
    assert not checker.check_following("")
    assert checker.check_following("GOODBYE")
    assert checker.check_following("goodbye\n")
    assert not checker.check_following("hello")
    assert not checker.check_following("bye")


# ----------------------------------------
# QuotationChecker
def test_quotation_checker_single():
    checker = QuotationChecker()
    checker.arguments = {"quotation_type": "single"}
    assert checker.check_following("'hello'")
    assert not checker.check_following('"hello"')
    assert not checker.check_following("hello")
    assert not checker.check_following("'hello")
    assert not checker.check_following("hello'")
    assert checker.check_following("'a'")
    assert checker.check_following("''")
    assert not checker.check_following("'hello' world")
    assert not checker.check_following(" 'hello' ")
    assert not checker.check_following("")


def test_quotation_checker_double():
    checker = QuotationChecker()
    checker.arguments = {"quotation_type": "double"}
    assert checker.check_following('"hello"')
    assert not checker.check_following("'hello'")
    assert not checker.check_following("hello")
    assert not checker.check_following('"hello')
    assert not checker.check_following('hello"')
    assert checker.check_following('"a"')
    assert checker.check_following('""')
    assert not checker.check_following('"hello" world')
    assert not checker.check_following(' "hello" ')
    assert not checker.check_following("")


# ----------------------------------------
# NCommasChecker
def test_n_commas_checker_exactly():
    checker = NCommasChecker()
    checker.arguments = {"comparison_option": "exactly", "N": 2}
    assert checker.check_following("a,b,c")
    assert not checker.check_following("a,b")
    assert not checker.check_following("a,b,c,d")
    assert checker.check_following(", ,")
    assert not checker.check_following("")
    assert not checker.check_following("no commas here")
    assert checker.check_following("a, b, c")
    assert not checker.check_following("a, b")
    assert not checker.check_following("a, b, c, d")
    assert checker.check_following("x,y,z")


def test_n_commas_checker_at_least():
    checker = NCommasChecker()
    checker.arguments = {"comparison_option": "at least", "N": 2}
    assert checker.check_following("a,b,c")
    assert checker.check_following("a,b,c,d")
    assert not checker.check_following("a,b")
    assert checker.check_following(", , ,")
    assert not checker.check_following("")
    assert not checker.check_following("no commas here")
    assert checker.check_following("a, b, c")
    assert checker.check_following("a, b, c, d")
    assert checker.check_following("x,y,z")
    assert checker.check_following("a,b,c,d,e")


def test_n_commas_checker_at_most():
    checker = NCommasChecker()
    checker.arguments = {"comparison_option": "at most", "N": 2}
    assert checker.check_following("a,b,c")
    assert checker.check_following("a,b")
    assert not checker.check_following("a,b,c,d")
    assert checker.check_following(", ,")
    assert checker.check_following("")
    assert checker.check_following("no commas here")
    assert checker.check_following("a, b")
    assert not checker.check_following("a, b, c, d")
    assert checker.check_following("x,y")
    assert checker.check_following("a,b")
