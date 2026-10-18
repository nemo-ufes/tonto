import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['out/**', 'src/generated/**']
    },
    ...tseslint.configs.recommended,
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
        }
    }
);
