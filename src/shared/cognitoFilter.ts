/** A value inside the quotes of a Cognito ListUsers `Filter`. Backslashes go first: escaping the quote first would let a trailing `\` cancel the quote's own escape. */
export const cognitoFilterValue = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
