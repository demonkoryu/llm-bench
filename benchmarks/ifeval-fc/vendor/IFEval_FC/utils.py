import random
import re
import string
from typing import Literal, TypeAlias

ComparisonOption: TypeAlias = Literal["exactly", "at most", "at least"]

EN_WORD_LIST: list[str] = list(
    set(
        [
            "day",
            "night",
            "light",
            "dark",
            "good",
            "bad",
            "happy",
            "sad",
            "quick",
            "slow",
            "strong",
            "weak",
            "large",
            "small",
            "early",
            "late",
            "easy",
            "hard",
            "open",
            "close",
            "high",
            "low",
            "right",
            "left",
            "young",
            "old",
            "new",
            "old",
            "long",
            "short",
            "friend",
            "enemy",
            "truth",
            "lie",
            "love",
            "hate",
            "peace",
            "war",
            "calm",
            "storm",
            "safe",
            "danger",
            "clear",
            "simple",
            "complex",
            "rather",
            "moderate",
            "always",
            "never",
            "begin",
            "end",
            "start",
            "finish",
            "above",
            "below",
            "before",
            "after",
            "first",
            "last",
            "early",
            "late",
            "fast",
            "slow",
            "hot",
            "cold",
            "wet",
            "dry",
            "hard",
            "soft",
            "sharp",
            "dull",
            "thick",
            "thin",
            "deep",
            "shallow",
            "wide",
            "narrow",
            "short",
            "tall",
            "young",
            "old",
            "rich",
            "poor",
            "full",
            "empty",
            "clean",
            "dirty",
            "strong",
            "weak",
            "brave",
            "coward",
            "wise",
            "fool",
            "kind",
            "cruel",
            "quiet",
            "loud",
            "soft",
            "rough",
            "smooth",
            "bitter",
            "sweet",
            "fresh",
            "stale",
            "bright",
            "dim",
            "clear",
            "cloudy",
            "busy",
            "idle",
            "active",
            "lazy",
            "simple",
            "complex",
            "plain",
            "fancy",
            "safe",
            "risky",
            "public",
            "private",
            "common",
            "rare",
            "usual",
            "strange",
            "normal",
            "odd",
            "major",
            "minor",
            "main",
            "side",
            "central",
            "remote",
            "local",
            "global",
            "urban",
            "rural",
            "ancient",
            "modern",
            "future",
            "past",
            "present",
            "final",
            "initial",
            "primary",
            "secondary",
            "basic",
            "advanced",
            "general",
            "special",
            "specific",
            "universal",
            "unique",
            "typical",
            "atypical",
            "regular",
            "irregular",
            "frequent",
            "seldom",
            "constant",
            "variable",
            "steady",
            "unstable",
            "permanent",
            "temporary",
            "fixed",
            "flexible",
            "mobile",
            "static",
            "visible",
            "hidden",
            "obvious",
            "subtle",
            "direct",
            "indirect",
            "straight",
            "curved",
            "flat",
            "round",
            "square",
            "triangular",
            "rectangular",
            "circular",
            "oval",
            "solid",
            "liquid",
            "gas",
            "heavy",
            "lightweight",
            "thick",
            "thin",
            "broad",
            "narrow",
            "tall",
            "short",
            "deep",
            "shallow",
            "long",
            "brief",
            "quick",
            "slow",
            "rapid",
            "gradual",
            "sudden",
            "delayed",
            "early",
            "late",
            "timely",
            "untimely",
            "open",
            "closed",
            "locked",
            "unlocked",
            "free",
            "bound",
            "attached",
            "detached",
            "joined",
            "separate",
        ]
    )
)

COMPARISON_OPTIONS: list[ComparisonOption] = [
    "exactly",  # ==
    "at most",  # <=
    "at least",  # >=
]

END_PHRASES: list[str] = [
    "that's it",
    "end of response",
    "no further information",
    "this is the end",
    "all done",
    "that's all",
    "nothing more to add",
    "end of argument",
]


def clean_and_split(text: str, lower: bool = True) -> list[str]:
    """Splits text into words"""
    translator = str.maketrans(string.punctuation, " " * len(string.punctuation))
    cleaned = text.translate(translator)
    if lower:
        return cleaned.lower().split()
    return cleaned.split()


def sample_keywords() -> list[str]:
    n_keywords: int = random.randint(2, 5)
    return random.sample(EN_WORD_LIST, n_keywords)


def sample_keyword() -> str:
    return random.choice(EN_WORD_LIST)


def sample_comparison_option(
    ignore_options: list[ComparisonOption] | None = None,
) -> ComparisonOption:
    if ignore_options is None:
        return random.choice(COMPARISON_OPTIONS)

    remaining_options: list[ComparisonOption] = [
        option for option in COMPARISON_OPTIONS if option not in ignore_options
    ]
    return random.choice(remaining_options)


def compare_count(result: int, N: int, comparison_option: ComparisonOption) -> bool:
    if comparison_option == "at least":
        return result >= N
    elif comparison_option == "at most":
        return result <= N
    elif comparison_option == "exactly":
        return result == N


_ALPHABETS = "([A-Za-z])"
_PREFIXES = "(Mr|St|Mrs|Ms|Dr)[.]"
_SUFFIXES = "(Inc|Ltd|Jr|Sr|Co)"
_STARTERS = r"(Mr|Mrs|Ms|Dr|Prof|Capt|Cpt|Lt|He\s|She\s|It\s|They\s|Their\s|Our\s|We\s|But\s|However\s|That\s|This\s|Wherever)"
_ACRONYMS = "([A-Z][.][A-Z][.](?:[A-Z][.])?)"
_WEBSITES = "[.](com|net|org|io|gov|edu|me)"
_DIGITS = "([0-9])"
_MULTIPLE_DOTS = r"\.{2,}"


def extract_sentences(text: str) -> list[str]:
    """
    Splits the text into sentences and returns a number of them.

    Args:
        text: A string that consists of more than or equal to one sentences.

    Returns:
        A length of a list of strings where each string is a sentence.
    """
    text = " " + text + "  "
    text = text.replace("\n", " ")
    text = re.sub(_PREFIXES, "\\1<prd>", text)
    text = re.sub(_WEBSITES, "<prd>\\1", text)
    text = re.sub(_DIGITS + "[.]" + _DIGITS, "\\1<prd>\\2", text)
    text = re.sub(
        _MULTIPLE_DOTS,
        lambda match: "<prd>" * len(match.group(0)) + "<stop>",
        text,
    )
    if "Ph.D" in text:
        text = text.replace("Ph.D.", "Ph<prd>D<prd>")
    text = re.sub(r"\s" + _ALPHABETS + "[.] ", " \\1<prd> ", text)
    text = re.sub(_ACRONYMS + " " + _STARTERS, "\\1<stop> \\2", text)
    text = re.sub(
        _ALPHABETS + "[.]" + _ALPHABETS + "[.]" + _ALPHABETS + "[.]",
        "\\1<prd>\\2<prd>\\3<prd>",
        text,
    )
    text = re.sub(_ALPHABETS + "[.]" + _ALPHABETS + "[.]", "\\1<prd>\\2<prd>", text)
    text = re.sub(" " + _SUFFIXES + "[.] " + _STARTERS, " \\1<stop> \\2", text)
    text = re.sub(" " + _SUFFIXES + "[.]", " \\1<prd>", text)
    text = re.sub(" " + _ALPHABETS + "[.]", " \\1<prd>", text)
    if "”" in text:
        text = text.replace(".”", "”.")
    if '"' in text:
        text = text.replace('."', '".')
    if "!" in text:
        text = text.replace('!"', '"!')
    if "?" in text:
        text = text.replace('?"', '"?')
    text = text.replace(".", ".<stop>")
    text = text.replace("?", "?<stop>")
    text = text.replace("!", "!<stop>")
    text = text.replace("<prd>", ".")
    sentences = text.split("<stop>")
    sentences = [s.strip() for s in sentences]
    if sentences and not sentences[-1]:
        sentences = sentences[:-1]

    return sentences


def check_postscript(arg_value: str, postscript_marker: str) -> bool:
    """
    Checks if the given string ends with a postscript starting with the specified marker.

    Supports flexible spacing (e.g., "P. S." vs "P.S.") and case insensitivity.

    Args:
        arg_value: The response string to check.
        marker: The expected postscript marker (e.g., "P.S.", "P.P.S").

    Returns:
        True if a postscript with the marker is found at the end; False otherwise.
    """

    value = arg_value.lower()

    match postscript_marker:
        case "P.P.S.":
            postscript_pattern = r"\s*p\.\s?p\.\s?s.*$"
        case "P.S.":
            postscript_pattern = r"\s*p\.\s?s\..*$"
        case _:
            postscript_pattern = r"\s*" + postscript_marker.lower() + r".*$"

    postscript = re.findall(postscript_pattern, value, flags=re.MULTILINE)
    return True if postscript else False


def count_highlighted_sections(arg_value: str) -> int:
    num_highlights = 0

    # Find all double asterisk sections (including newlines)
    double_highlights = re.findall(r"\*\*.*?\*\*", arg_value, re.DOTALL)

    # Find all single asterisk sections (excluding those that are part of double asterisks)
    # Use a more careful approach to avoid overlapping matches
    temp_text = arg_value
    for highlight in double_highlights:
        temp_text = temp_text.replace(highlight, "")  # Remove double highlights first

    single_highlights = re.findall(r"\*.*?\*", temp_text, re.DOTALL)

    # Count valid double highlights
    for highlight in double_highlights:
        content = highlight[2:-2].strip()  # Remove ** from both ends
        if content:  # Check if there's any non-whitespace content
            num_highlights += 1

    # Count valid single highlights
    for highlight in single_highlights:
        content = highlight[1:-1].strip()  # Remove * from both ends
        if content:  # Check if there's any non-whitespace content
            num_highlights += 1

    return num_highlights


def sample_end_phrase() -> str:
    return random.choice(END_PHRASES)
