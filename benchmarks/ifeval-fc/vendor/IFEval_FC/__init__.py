"""
IFEval-FC: A Function Call Evaluation Framework

This package provides a comprehensive framework for evaluating AI assistant function calling capabilities
through diverse string parameter format constraints and validation checkers.

Main components:
- checkers: Various format validation checkers (keywords, language, length, etc.)
- prompts: Templates for generating evaluation data
- utils: Utility functions for text processing and validation
- data: Evaluation datasets with various format constraints
"""

__version__ = "1.0.0"
__author__ = "Nikolai Skripko"
__email__ = "nskripko@icloud.com"

# Import main checker classes for easy access
from .checkers import (
    AllLowercaseChecker,
    AllUppercaseChecker,
    BaseChecker,
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
    PythonListFormatChecker,
    QuotationChecker,
    SentenceCountChecker,
    SpacesInBetweenChecker,
    TitleFormatChecker,
    WordCountChecker,
    get_all_checkers,
)

# Import prompt templates
from .prompts import (
    ADD_FORMAT_TO_DESC_PROMPT_TEMPLATE,
    DOMAINS,
    GENERATE_JSON_SCHEMAS_PROMPT_TEMPLATE,
    GENERATE_USER_QUERIES_PROMPT_TEMPLATE,
)

# Import utility functions
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

__all__ = [
    # Checker classes
    "BaseChecker",
    "KeywordsPresenceChecker",
    "KeywordFrequencyChecker",
    "LetterFrequencyChecker",
    "CyrillicGreekChecker",
    "WordCountChecker",
    "SentenceCountChecker",
    "PostscriptChecker",
    "PlaceholderCountChecker",
    "SpacesInBetweenChecker",
    "TitleFormatChecker",
    "HighlightedSectionsCountChecker",
    "JsonFormatChecker",
    "PythonListFormatChecker",
    "AllUppercaseChecker",
    "AllLowercaseChecker",
    "NAllCapitalWordsChecker",
    "EndPhraseChecker",
    "QuotationChecker",
    "NCommasChecker",
    "get_all_checkers",
    # Utility functions
    "clean_and_split",
    "sample_keywords",
    "sample_keyword",
    "sample_comparison_option",
    "compare_count",
    "extract_sentences",
    "check_postscript",
    "count_highlighted_sections",
    "sample_end_phrase",
    "ComparisonOption",
    # Prompt templates
    "DOMAINS",
    "GENERATE_JSON_SCHEMAS_PROMPT_TEMPLATE",
    "ADD_FORMAT_TO_DESC_PROMPT_TEMPLATE",
    "GENERATE_USER_QUERIES_PROMPT_TEMPLATE",
]
