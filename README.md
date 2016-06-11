# eslint-plugin-import

This is a fork of [Ben Mosher's fantastic plugin](https://github.com/benmosher/eslint-plugin-import). You probably want to install that one instead.

I love what eslint-plugin-import gives us, but I want more granular sorting of my imports. Hopefully I'll soon have time to clean this up and do a proper PR back into the main library (if it's wanted).

### --fix

I implemented some very basic --fix functionality for the import/order rule. It's only available when you set `fixable:true`. USE AT YOUR OWN RISK:

- It hasn't been tested very thoroughly
- When fixable is true, some of the eslint flags are hard coded
- When this fix is run with other fixes (notably, object-curly), bad things can happen:

If your code snippet looks like this:

```
import foo from 'foo'
import {bar} from 'bar'
```

After fix it could end up looking like this:

```
import {bar} from 'bar'
import { bar } from 'bar'
```

In this case, the import/order fix ran first, switching foo and bar. Then the object-curly fix ran, replacing line 2 with a duplicate of what line 2 used to be, but with spaces in it.
