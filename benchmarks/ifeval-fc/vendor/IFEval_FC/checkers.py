"""
This file defines a comprehensive set of string parameter formats, organized into 8 distinct categories.
Each category represents a different type of constraint or requirement that can be imposed on a string argument.
These formats are used to generate and evaluate diverse string inputs for the IFEvalFC benchmark, enabling fine-grained control over the structure, content, and style of argument values.

Categories:
1. KEYWORDS: Constraints related to the presence, absence, or frequency of specific keywords or letters.
2. LANGUAGE: Requirements regarding the language(s) used in the argument value.
3. LENGTH_CONSTRAINT: Restrictions on the number of words or sentences in the argument value.
4. DETECTABLE_CONTENT: Requirements for specific content patterns or markers that can be programmatically detected.
5. DETECTABLE_FORMAT: Constraints on the structural or formatting features of the argument value.
6. CASE: Requirements related to letter casing, such as all uppercase or lowercase, or a certain number of capitalized words.
7. START_END: Constraints on how the argument value must begin or end, or on enclosing punctuation.
8. PUNCTUATION: Restrictions or requirements regarding the use of punctuation marks.

Each format string may contain placeholders (e.g., {N}, {keyword}, {language}) to be filled in with specific values when generating or validating argument values.
"""

import json
import random
import re
import string
from typing import Any

import nltk
from typing_extensions import override

from .utils import (
    ComparisonOption,
    check_postscript,
    clean_and_split,
    compare_count,
    count_highlighted_sections,
    extract_sentences,
    sample_comparison_option,
    sample_end_phrase,
    sample_keyword,
    sample_keywords,
)

# =============================================================================================================================


class BaseChecker:
    """
    Abstract base class for checkers that validate argument values.
    Subclasses must implement `get_description` and `check_following`.
    """

    instruction_group: str = "base"

    def __init__(self):
        self.sample_state()

    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        raise NotImplementedError(
            "Method `sample_arguments` must be implemented by subclasses."
        )

    def build_description(self) -> str:
        raise NotImplementedError(
            "Method `get_description` must be implemented by subclasses."
        )

    def check_following(self, arg_value: str) -> bool:
        raise NotImplementedError(
            f"Method `check_following({arg_value})` must be implemented by subclasses."
        )

    def get_description(self):
        return self.description

    def get_args(self):
        return self.arguments

    def sample_state(self) -> None:
        self.arguments: dict[str, Any] = (
            self.sample_arguments()
        )  # pyright: ignore[reportExplicitAny]
        self.description: str = self.build_description()


# ============================================================================================== #
#                                          KEYWORDS                                              #
# ============================================================================================== #


class KeywordsPresenceChecker(BaseChecker):
    """
    Checker that validates whether a given string contains or does not contain all specified keywords at least once,
    depending on the 'must_include' argument. Case-insensitive and ignores punctuation.
    """

    instruction_group: str = "KEYWORDS"

    @override
    def sample_arguments(self) -> dict[str, Any]:
        return {
            "list_of_keywords": sample_keywords(),
            "must_include": random.choice([True, False]),
        }

    @override
    def build_description(self) -> str:
        keywords = self.arguments["list_of_keywords"]
        must_include = self.arguments["must_include"]
        if must_include:
            return f"The argument value must include the keywords: {keywords}. Each keyword must appear at least once, in any order. Case does not matter."
        else:
            return f"The argument value must not include the keywords: {keywords}. None of these words should appear anywhere in the value. Case does not matter."

    @override
    def check_following(self, arg_value: str) -> bool:
        keywords = self.arguments["list_of_keywords"]
        must_include = self.arguments["must_include"]
        words = clean_and_split(arg_value)
        keyword_lower = [kw.lower() for kw in keywords]
        if must_include:
            return all(keyword in words for keyword in keyword_lower)
        else:
            return all(keyword not in words for keyword in keyword_lower)


class KeywordFrequencyChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a specified keyword a certain number of times,
    according to a comparison option (e.g., at least N, exactly N, at most N).

    - The check is case-insensitive and ignores punctuation.
    - The keyword is matched as a whole word, not as a substring.
    """

    instruction_group: str = "KEYWORDS"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        keyword = sample_keyword()
        comparison_option: ComparisonOption = sample_comparison_option()
        match comparison_option:
            case "at least":
                n_keywords = random.randint(1, 2)
            case "at most":
                n_keywords = random.randint(1, 2)
            case "exactly":
                n_keywords = random.randint(1, 2)

        return {
            "keyword": keyword,
            "N": n_keywords,
            "comparison_option": comparison_option,
        }

    @override
    def build_description(self) -> str:
        keyword = self.arguments["keyword"]
        N: int = self.arguments["N"]
        comparison_option: ComparisonOption = self.arguments["comparison_option"]
        plural_form: str = "s" if N > 1 else ""
        return f"The argument value must contain the word '{keyword}' {comparison_option} {N} time{plural_form}. The occurrences may be anywhere in the string. Case does not matter."

    @override
    def check_following(self, arg_value: str) -> bool:
        keyword = self.arguments["keyword"]
        N: int = self.arguments["N"]
        comparison_option: ComparisonOption = self.arguments["comparison_option"]
        words = clean_and_split(arg_value)
        count = words.count(keyword.lower())
        return compare_count(count, N, comparison_option)


class LetterFrequencyChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a specified letter a certain number of times,
    according to a comparison option (e.g., at least N, exactly N, at most N), regardless of case.
    """

    instruction_group: str = "KEYWORDS"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        letter = random.choice(string.ascii_lowercase)
        comparison_option: ComparisonOption = sample_comparison_option()
        n_letters = random.randint(1, 10)

        return {
            "letter": letter,
            "N": n_letters,
            "comparison_option": comparison_option,
        }

    @override
    def build_description(self) -> str:
        letter: str = self.arguments["letter"]
        N: int = self.arguments["N"]
        comparison_option: ComparisonOption = self.arguments["comparison_option"]
        plural_form: str = "s" if N > 1 else ""
        return (
            f"The argument value must contain the letter '{letter}' {comparison_option} {N} time{plural_form}. "
            "Case does not matter."
        )

    @override
    def check_following(self, arg_value: str) -> bool:
        letter = self.arguments["letter"]
        N: int = self.arguments["N"]
        comparison_option = self.arguments["comparison_option"]

        count = arg_value.lower().count(letter.lower())
        return compare_count(count, N, comparison_option)


# ============================================================================================== #
#                                          LANGUAGE                                              #
# ============================================================================================== #


class CyrillicGreekChecker(BaseChecker):
    """
    Checker that validates whether a given string is written entirely in either Cyrillic or Greek letters.
    No Latin, CJK, or other scripts are allowed.
    """

    instruction_group: str = "LANGUAGE"

    @override
    def sample_arguments(self) -> dict[str, str]:
        # Randomly choose between 'cyrillic' and 'greek'
        script = random.choice(["cyrillic", "greek"])
        return {"script": script}

    @override
    def build_description(self) -> str:
        script = self.arguments["script"]
        script_desc = "Cyrillic" if script == "cyrillic" else "Greek"
        return (
            f"The argument value must be written entirely in {script_desc} letters. "
            "No letters from other scripts are allowed."
        )

    @override
    def check_following(self, arg_value: str) -> bool:
        script = self.arguments["script"]
        # Unicode ranges:
        # Cyrillic: U+0400–U+04FF, U+0500–U+052F, U+2DE0–U+2DFF, U+A640–U+A69F
        # Greek: U+0370–U+03FF, U+1F00–U+1FFF
        if script == "cyrillic":
            pattern_str = (
                r"^[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F0-9\s\W]*$"
            )
        else:  # greek
            pattern_str = r"^[\u0370-\u03FF\u1F00-\u1FFF0-9\s\W]*$"
        pattern = re.compile(pattern_str)
        return bool(pattern.fullmatch(arg_value))


# ============================================================================================== #
#                                   LENGTH CONSTRAINTS                                           #
# ============================================================================================== #


class WordCountChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a number of words
    that matches a specified constraint (at least, at most, or exactly N words).
    """

    instruction_group: str = "LENGTH CONSTRAINTS"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        comparison_option: ComparisonOption = sample_comparison_option()
        match comparison_option:
            case "at least":
                n_words = random.randint(20, 40)
            case "at most":
                n_words = random.randint(2, 10)
            case "exactly":
                n_words = random.randint(1, 5)

        return {"N": n_words, "comparison_option": comparison_option}

    @override
    def build_description(self) -> str:
        N: int = self.arguments["N"]
        comparison_option: ComparisonOption = self.arguments["comparison_option"]
        plural_form: str = "s" if N > 1 else ""

        match comparison_option:
            case "exactly":
                return f"The argument value must have exactly {N} word{plural_form}. No less, no more."
            case "at least":
                return f"The argument value must have at least {N} word{plural_form}. Shorter responses are not allowed."
            case "at most":
                return f"The argument value must have at most {N} word{plural_form}. Longer responses are not allowed."

    @override
    def check_following(self, arg_value: str) -> bool:
        N: int = self.arguments["N"]
        comparison_option: ComparisonOption = self.arguments["comparison_option"]
        tokenizer = nltk.tokenize.RegexpTokenizer(r"\w+")
        words = tokenizer.tokenize(arg_value)
        return compare_count(len(words), N, comparison_option)


class SentenceCountChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a number of sentences
    that matches a specified constraint (at least, at most, or exactly N sentences).
    Each sentence should be properly punctuated.
    """

    # TODO: the underlying parser sometimes failes to calculate the number of sentences correctly.
    # To this end, the exact option was emitted due to unstable results.

    instruction_group: str = "LENGTH CONSTRAINTS"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        comparison_option: ComparisonOption = sample_comparison_option(
            ignore_options=["exactly"]
        )
        match comparison_option:
            case "at least":
                n_sentences = random.randint(1, 8)
            case "at most":
                n_sentences = random.randint(1, 4)
            case "exactly":  # actually, unreachable
                n_sentences = random.randint(1, 5)

        return {"N": n_sentences, "comparison_option": comparison_option}

    @override
    def build_description(self) -> str:
        N: int = self.arguments["N"]
        comparison_option: ComparisonOption = self.arguments["comparison_option"]
        plural_form: str = (
            "s. Each sentence should be properly punctuated." if N > 1 else "."
        )
        return f"The argument value must have {comparison_option} {N} sentence{plural_form}"

    @override
    def check_following(self, arg_value: str) -> bool:
        N: int = self.arguments["N"]
        comparison_option = self.arguments["comparison_option"]
        sentences = extract_sentences(arg_value)
        return compare_count(len(sentences), N, comparison_option)


# ============================================================================================== #
#                                   DETECTABLE CONTENT                                           #
# ============================================================================================== #


class PostscriptChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a postscript
    that begins with a specified marker (e.g., 'P.S.' or 'P.P.S.').
    The marker may have optional whitespace (e.g., 'P. S.' or 'P. P. S.').
    """

    instruction_group: str = "DETECTABLE CONTENT"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        # Randomly choose between "P.S." and "P.P.S." (aka "P.S.S.")
        marker = random.choice(["P.S.", "P.P.S."])
        return {"postscript_marker": marker}

    @override
    def build_description(self) -> str:
        marker = self.arguments["postscript_marker"]
        if marker == "P.S.":
            return (
                "The argument value must contain a postscript that begins with the marker 'P.S.'. "
                "The marker may have optional whitespace (e.g., 'P. S.')."
            )
        elif marker == "P.P.S.":
            return (
                "The argument value must contain a postscript that begins with the marker 'P.P.S.'. "
                "The marker may have optional whitespace (e.g., 'P. P. S.')."
            )
        else:
            return "The argument value must contain a postscript with the specified marker."

    @override
    def check_following(self, arg_value: str) -> bool:
        marker = self.arguments["postscript_marker"]
        return check_postscript(arg_value, marker)


class PlaceholderCountChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a specified number of placeholders,
    each enclosed in square brackets (e.g., [address]).
    Supports minimum, exact, and maximum count constraints.
    """

    instruction_group: str = "DETECTABLE CONTENT"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        comparison_option: ComparisonOption = sample_comparison_option()
        match comparison_option:
            case "at least":
                n_placeholders = random.randint(1, 5)
            case "at most":
                n_placeholders = random.randint(1, 2)
            case "exactly":
                n_placeholders = random.randint(3, 7)
        return {"comparison_option": comparison_option, "N": n_placeholders}

    @override
    def build_description(self) -> str:
        comparison_option = self.arguments["comparison_option"]
        N: int = self.arguments["N"]
        plural_form: str = "s" if N > 1 else ""
        return f"The argument value must contain {comparison_option} {N} placeholder{plural_form}, each enclosed in square brackets (e.g., [address])."

    @override
    def check_following(self, arg_value: str) -> bool:
        comparison_option = self.arguments["comparison_option"]
        N: int = self.arguments["N"]
        placeholders = re.findall(r"\[.*?\]", arg_value)
        count = len(placeholders)
        return compare_count(count, N, comparison_option)


# ============================================================================================== #
#                                    DETECTABLE FORMAT                                           #
# ============================================================================================== #


class SpacesInBetweenChecker(BaseChecker):
    """
    Checker that validates whether a given string uses exactly `N` consecutive spaces between every pair of words,
    with no single spaces, and no leading or trailing spaces.
    """

    instruction_group: str = "DETECTABLE FORMAT"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        return {"N": random.randint(5, 10)}

    @override
    def build_description(self) -> str:
        N: int = self.arguments["N"]
        return f"The argument value must use exactly {N} consecutive spaces between every pair of words. Only {N} spaces in a row are allowed in the string."

    @override
    def check_following(self, arg_value: str) -> bool:
        N: int = self.arguments["N"]

        SEPARATOR: str = " " * N

        arg_value = str(arg_value)
        # No leading or trailing spaces
        if arg_value != arg_value.strip():
            return False

        # If it's a single word, it's valid
        if " " not in arg_value:
            return True

        # Split on four spaces
        parts = arg_value.split(SEPARATOR)
        if len(parts) < 2:
            return False

        if any(part == "" for part in parts):
            return False

        reconstructed = SEPARATOR.join(parts)
        if reconstructed != arg_value:
            return False

        if any(" " in part for part in parts):
            return False

        return True


class TitleFormatChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a title wrapped in double angle brackets, such as <<poem of joy>>.
    """

    instruction_group: str = "DETECTABLE FORMAT"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        return {}

    @override
    def build_description(self) -> str:
        return "The argument value must contain a title wrapped in double angle brackets, such as <<poem of joy>> (everything except for the title is allowed)."

    @override
    def check_following(self, arg_value: str) -> bool:
        pattern = r"<<[^\n]+>>"
        re_pattern = re.compile(pattern)
        titles = re.findall(re_pattern, arg_value)

        for title in titles:
            if title.lstrip("<").rstrip(">").strip():
                return True
        return False


class HighlightedSectionsCountChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a number of highlighted sections (using markdown syntax,
    e.g., *highlighted section* or **highlighted section**) that matches a comparison option and value. Each section must not be empty.
    """

    instruction_group: str = "DETECTABLE FORMAT"

    @override
    def sample_arguments(self) -> dict[str, Any]:
        comparison_option: ComparisonOption = sample_comparison_option()
        match comparison_option:
            case "at least":
                n_highlighted_sections = random.randint(1, 5)
            case "at most":
                n_highlighted_sections = random.randint(1, 2)
            case "exactly":
                n_highlighted_sections = random.randint(3, 7)
        return {"comparison_option": comparison_option, "N": n_highlighted_sections}

    @override
    def build_description(self) -> str:
        comparison_option = self.arguments["comparison_option"]
        N: int = self.arguments["N"]
        plural_form: str = "s" if N > 1 else ""
        return (
            f"The argument value must contain {comparison_option} {N} section{plural_form} highlighted using markdown syntax "
            "(e.g., *highlighted section* or **highlighted section**). Each section must not be empty."
        )

    @override
    def check_following(self, arg_value: str) -> bool:
        comparison_option = self.arguments["comparison_option"]
        N: int = self.arguments["N"]
        num_highlights = count_highlighted_sections(arg_value)
        return compare_count(num_highlights, N, comparison_option)


class JsonFormatChecker(BaseChecker):
    """
    Checker that validates whether a given string is a valid JSON object.
    The JSON must be syntactically correct and parseable.
    """

    instruction_group: str = "DETECTABLE FORMAT"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        return {}

    @override
    def build_description(self) -> str:
        return "The argument value must be a valid JSON object. The JSON must be syntactically correct and parseable."

    @override
    def check_following(self, arg_value: str) -> bool:
        value = (
            arg_value.strip()
            .removeprefix("```json")
            .removeprefix("```Json")
            .removeprefix("```JSON")
            .removeprefix("```")
            .removesuffix("```")
            .strip()
        )
        try:
            json.loads(value)
        except ValueError:
            return False
        return True


class PythonListFormatChecker(BaseChecker):
    """
    Checker that validates whether a given string is a valid python list of strings.
    The list must be syntactically correct and parseable with ast.literal_eval().
    """

    instruction_group: str = "DETECTABLE FORMAT"

    @override
    def sample_arguments(self) -> dict[str, Any]:
        return {}

    @override
    def build_description(self) -> str:
        return (
            "The argument value must be a valid python list of strings. "
            "The list must be syntactically correct and parseable with ast.literal_eval()."
        )

    @override
    def check_following(self, arg_value: str) -> bool:
        value = arg_value.strip()
        # Remove code block markers if present
        if value.startswith("```python"):
            value = value[len("```python") :].strip()
        elif value.startswith("```Python"):
            value = value[len("```Python") :].strip()
        elif value.startswith("```PYTHON"):
            value = value[len("```PYTHON") :].strip()
        elif value.startswith("```"):
            value = value[len("```") :].strip()
        if value.endswith("```"):
            value = value[:-3].strip()
        try:
            import ast

            parsed = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            return False
        if not isinstance(parsed, list):
            return False
        # Check that all elements are strings
        return all(isinstance(item, str) for item in parsed)


# ============================================================================================== #
#                                             CASE                                               #
# ============================================================================================== #


class AllUppercaseChecker(BaseChecker):
    """
    Checker that validates whether a given string is entirely in uppercase.
    No lowercase letters are allowed.
    """

    instruction_group: str = "CASE"

    @override
    def sample_arguments(self) -> dict[str, Any]:
        return {}

    @override
    def build_description(self) -> str:
        return "The argument value must be in uppercase. A string is uppercase if all cased characters in the string are uppercase and there is at least one cased character in the string."

    @override
    def check_following(self, arg_value: str) -> bool:
        return arg_value.isupper()


class AllLowercaseChecker(BaseChecker):
    """
    Checker that validates whether a given string is entirely in lowercase.
    No uppercase letters are allowed.
    """

    instruction_group: str = "CASE"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        return {}

    @override
    def build_description(self) -> str:
        return "The argument value must be in lowercase. A string is lowercase if all cased characters in the string are lowercase and there is at least one cased character in the string."

    @override
    def check_following(self, arg_value: str) -> bool:
        return arg_value.islower()


class NAllCapitalWordsChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a specified number of words written entirely in capital (uppercase) letters.
    Supports minimum, exact, and maximum count constraints via ComparisonOption.
    """

    instruction_group: str = "CASE"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        comparison_option: ComparisonOption = sample_comparison_option()
        match comparison_option:
            case "at least":
                n_all_capital_words = random.randint(1, 5)
            case "at most":
                n_all_capital_words = random.randint(1, 2)
            case "exactly":
                n_all_capital_words = random.randint(3, 7)
        return {"comparison_option": comparison_option, "N": n_all_capital_words}

    @override
    def build_description(self) -> str:
        comparison_option = self.arguments["comparison_option"]
        N: int = self.arguments["N"]
        plural_form: str = "s" if N > 1 else ""
        return f"The argument value must contain {comparison_option} {N} word{plural_form} written entirely in capital (uppercase) letters."

    @override
    def check_following(self, arg_value: str) -> bool:
        comparison_option = self.arguments["comparison_option"]
        N: int = self.arguments["N"]
        words: list[str] = clean_and_split(arg_value, lower=False)
        all_capital_words = [word for word in words if word.isupper()]
        count = len(all_capital_words)
        return compare_count(count, N, comparison_option)


# ============================================================================================== #
#                                         START_END                                              #
# ============================================================================================== #


class EndPhraseChecker(BaseChecker):
    """
    Checker that validates whether a given string ends with a specified `end_phrase`.
    """

    instruction_group: str = "START_END"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        end_phrase: str = sample_end_phrase()
        return {"end_phrase": end_phrase}

    @override
    def build_description(self) -> str:
        end_phrase: str = self.arguments["end_phrase"]
        return f"The argument value must end with the exact phrase '{end_phrase}'. Only whitespaces are allowed after it. Case doesn't matter."

    @override
    def check_following(self, arg_value: str) -> bool:
        value = arg_value.strip().lower()
        end_phrase: str = self.arguments["end_phrase"]
        end_phrase = end_phrase.strip().lower()
        return value.endswith(end_phrase)


class QuotationChecker(BaseChecker):
    """
    Checker that validates whether a given string is wrapped in the specified quotation marks (single or double).
    No additional characters should appear outside the quotes.
    """

    instruction_group: str = "START_END"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        quotation_type = random.choice(["single", "double"])
        return {"quotation_type": quotation_type}

    @override
    def build_description(self) -> str:
        quotation_type = self.arguments["quotation_type"]

        desc = f"The argument value must be wrapped in {quotation_type} quotation marks.\n No additional characters should appear outside the quotes."
        return desc

    @override
    def check_following(self, arg_value: str) -> bool:
        quotation_type = self.arguments["quotation_type"]
        quotation_mark: str = '"' if quotation_type == "double" else "'"
        return (
            arg_value.startswith(quotation_mark)
            and arg_value.endswith(quotation_mark)
            and len(arg_value) >= 2
        )


# ============================================================================================== #
#                                         PUNCTUATION                                            #
# ============================================================================================== #


class NCommasChecker(BaseChecker):
    """
    Checker that validates whether a given string contains a specified number of commas.
    Supports minimum, exact, and maximum count constraints via ComparisonOption.
    """

    instruction_group: str = "PUNCTUATION"

    @override
    def sample_arguments(self) -> dict[str, Any]:  # pyright: ignore[reportExplicitAny]
        comparison_option: ComparisonOption = sample_comparison_option()
        match comparison_option:
            case "at least":
                n_commas = random.randint(3, 7)
            case "at most":
                n_commas = random.randint(1, 3)
            case "exactly":
                n_commas = random.randint(1, 7)
        return {"comparison_option": comparison_option, "N": n_commas}

    @override
    def build_description(self) -> str:
        comparison_option: ComparisonOption = self.arguments["comparison_option"]
        N: int = self.arguments["N"]
        plural_form: str = "s" if N > 1 else ""
        return f"The argument value must contain {comparison_option} {N} comma{plural_form}. The commas may appear anywhere in the value."

    @override
    def check_following(self, arg_value: str) -> bool:
        count = arg_value.count(",")
        comparison_option: ComparisonOption = self.arguments["comparison_option"]
        N: int = self.arguments["N"]
        return compare_count(count, N, comparison_option)


def get_all_checkers() -> list[type[BaseChecker]]:
    """
    Get a list of all available checker classes.

    Returns:
        A list of all checker class types that inherit from BaseChecker.
    """
    return [
        KeywordsPresenceChecker,
        KeywordFrequencyChecker,
        LetterFrequencyChecker,
        CyrillicGreekChecker,
        WordCountChecker,
        SentenceCountChecker,
        PostscriptChecker,
        PlaceholderCountChecker,
        SpacesInBetweenChecker,
        TitleFormatChecker,
        HighlightedSectionsCountChecker,
        JsonFormatChecker,
        PythonListFormatChecker,
        AllUppercaseChecker,
        AllLowercaseChecker,
        NAllCapitalWordsChecker,
        EndPhraseChecker,
        QuotationChecker,
        NCommasChecker,
    ]
