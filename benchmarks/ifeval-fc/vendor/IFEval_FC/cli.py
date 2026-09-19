#!/usr/bin/env python3
"""
Command-line interface for IFEval-FC
"""

import argparse
import json
import sys
from pathlib import Path
from typing import List

from .checkers import BaseChecker, get_all_checkers
from .utils import ComparisonOption


def list_checkers():
    """List all available checker classes."""
    checkers = get_all_checkers()
    print("Available IFEval-FC Checkers:")
    print("=" * 50)

    for i, checker_class in enumerate(checkers, 1):
        print(f"{i:2d}. {checker_class.__name__}")
        print(f"    Group: {checker_class.instruction_group}")
        print(
            f"    Doc: {checker_class.__doc__.split('.')[0] if checker_class.__doc__ else 'No description'}"
        )
        print()


def test_checker(checker_name: str, test_string: str):
    """Test a specific checker with a given string."""
    checkers = get_all_checkers()
    checker_classes = {cls.__name__: cls for cls in checkers}

    if checker_name not in checker_classes:
        print(f"Error: Checker '{checker_name}' not found.")
        print("Available checkers:")
        for name in sorted(checker_classes.keys()):
            print(f"  - {name}")
        return

    checker_class = checker_classes[checker_name]
    checker = checker_class()

    print(f"Testing {checker_name}:")
    print(f"Description: {checker.get_description()}")
    print(f"Arguments: {checker.get_args()}")
    print(f"Test string: '{test_string}'")

    try:
        result = checker.check_following(test_string)
        print(f"Result: {'✓ PASS' if result else '✗ FAIL'}")
    except Exception as e:
        print(f"Error: {e}")


def validate_data_file(file_path: str):
    """Validate a data file format."""
    try:
        with open(file_path, "r") as f:
            data = json.load(f)

        print(f"Validating {file_path}:")

        # Check required fields
        if "format" not in data:
            print("  ✗ Missing 'format' field")
            return False

        format_info = data["format"]
        if "name" not in format_info:
            print("  ✗ Missing 'format.name' field")
            return False

        print(f"  ✓ Format: {format_info['name']}")
        print(f"  ✓ Group: {format_info.get('group', 'Unknown')}")

        # Check for function schema
        if "fn_schema" in data:
            print(f"  ✓ Function: {data['fn_schema'].get('name', 'Unknown')}")

        # Check for samples (if they exist)
        if "samples" in data:
            print(f"  ✓ Samples: {len(data['samples'])}")

            # Validate samples
            for i, sample in enumerate(data["samples"]):
                if "user_query" not in sample:
                    print(f"  ✗ Sample {i}: Missing 'user_query'")
                    return False

                if "function_call" not in sample:
                    print(f"  ✗ Sample {i}: Missing 'function_call'")
                    return False
        else:
            print("  ✓ No samples field (format definition only)")

        print("  ✓ All samples validated")
        return True

    except json.JSONDecodeError as e:
        print(f"  ✗ JSON decode error: {e}")
        return False
    except Exception as e:
        print(f"  ✗ Error: {e}")
        return False


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="IFEval-FC: Function Call Evaluation Framework CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  ifeval-fc list                           # List all available checkers
  ifeval-fc test KeywordsPresenceChecker "Hello world with keywords"  # Test a checker
  ifeval-fc validate data/sample.json      # Validate a data file
  ifeval-fc info                           # Show package information
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # List command
    list_parser = subparsers.add_parser("list", help="List all available checkers")

    # Test command
    test_parser = subparsers.add_parser("test", help="Test a specific checker")
    test_parser.add_argument("checker", help="Name of the checker to test")
    test_parser.add_argument("string", help="String to test against the checker")

    # Validate command
    validate_parser = subparsers.add_parser("validate", help="Validate a data file")
    validate_parser.add_argument("file", help="Path to the data file to validate")

    # Info command
    info_parser = subparsers.add_parser("info", help="Show package information")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    if args.command == "list":
        list_checkers()

    elif args.command == "test":
        test_checker(args.checker, args.string)

    elif args.command == "validate":
        if not Path(args.file).exists():
            print(f"Error: File '{args.file}' not found.")
            sys.exit(1)
        validate_data_file(args.file)

    elif args.command == "info":
        print("IFEval-FC: Function Call Evaluation Framework")
        print("Version: 1.0.0")
        print(
            "Description: A comprehensive framework for evaluating AI assistant function calling capabilities"
        )
        print()
        print("Features:")
        print("- 20+ format validation checkers")
        print("- 8 categories of constraints")
        print("- 150+ evaluation test cases")
        print("- Prompt templates for data generation")
        print()
        print("Use 'ifeval-fc list' to see all available checkers.")
        print("Use 'ifeval-fc test <checker> <string>' to test a checker.")
        print("Use 'ifeval-fc validate <file>' to validate data files.")


if __name__ == "__main__":
    main()
